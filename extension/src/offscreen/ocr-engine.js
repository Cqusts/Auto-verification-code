import { CHARSETS } from '../common/patterns.js';
import { sanitizeOcrText } from '../common/code-extract.js';
import { decodeImage, preprocess, canvasToDataUrl } from './image-lab.js';

const paths = {
  worker: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
  core: chrome.runtime.getURL('vendor/tesseract/tesseract-core-simd-lstm.wasm.js'),
  lang: chrome.runtime.getURL('vendor/tesseract/'),
};

let workerPromise = null;
let workerLang = null;
let idleTimer = null;

/** Tesseract takes ~1s to spin up; keep it warm for a minute between CAPTCHAs. */
const IDLE_DISPOSE_MS = 60_000;

function scheduleDispose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    disposeWorker().catch(() => {});
  }, IDLE_DISPOSE_MS);
}

async function getWorker(lang = 'eng') {
  if (workerPromise && workerLang === lang) return workerPromise;
  if (workerPromise) await disposeWorker();
  workerLang = lang;
  workerPromise = (async () => {
    if (typeof Tesseract === 'undefined') throw new Error('tesseract-not-loaded');
    return Tesseract.createWorker(lang, 1, {
      workerPath: paths.worker,
      corePath: paths.core,
      langPath: paths.lang,
      // MV3's CSP has no blob: in script-src, so the worker must load from its real URL.
      workerBlobURL: false,
      gzip: true,
      // IndexedDB caching buys nothing when the traineddata already ships locally.
      cacheMethod: 'none',
      legacyCore: false,
      legacyLang: false,
    });
  })();
  try {
    return await workerPromise;
  } catch (err) {
    workerPromise = null;
    workerLang = null;
    throw err;
  }
}

export async function disposeWorker() {
  const pending = workerPromise;
  workerPromise = null;
  workerLang = null;
  clearTimeout(idleTimer);
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    /* already gone */
  }
}

function charsetFor(captcha) {
  if (captcha.charset === 'custom') return captcha.customCharset || '';
  return CHARSETS[captcha.charset] ?? CHARSETS.alnum;
}

/**
 * Ranks a candidate: Tesseract confidence, plus a strong bonus for matching the
 * expected length, because a CAPTCHA with the wrong number of characters is
 * always wrong however confident the engine feels.
 */
function scoreCandidate(text, confidence, expectedLength) {
  if (!text) return -1;
  let score = confidence;
  if (expectedLength > 0) {
    if (text.length === expectedLength) score += 25;
    else score -= Math.min(40, Math.abs(text.length - expectedLength) * 20);
  }
  return score;
}

async function recognizeCanvas(worker, canvas, { psm, charset }) {
  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    tessedit_char_whitelist: charset,
    // CAPTCHAs are not words; the dictionary only hurts.
    load_system_dawg: '0',
    load_freq_dawg: '0',
    user_defined_dpi: '300',
  });
  const { data } = await worker.recognize(canvas);
  return { raw: data?.text ?? '', confidence: data?.confidence ?? 0 };
}

/**
 * Runs the local OCR engine over a few pre-processing variants and returns the best.
 *
 * @param {{dataUrl:string, crop?:object|null, captcha:object}} input
 * @returns {Promise<{text:string, confidence:number, attempts:number, variant:string, preview:string}>}
 */
export async function recognize({ dataUrl, crop = null, captcha }) {
  const charset = charsetFor(captcha);
  const expectedLength = Number(captcha.expectedLength) || 0;
  const psm = Number(captcha.local?.psm) || 7;
  const lang = captcha.local?.lang || 'eng';

  const bitmap = await decodeImage(dataUrl);
  const worker = await getWorker(lang);

  // Ordered cheapest-first; we stop as soon as one is convincingly good.
  const variants = [
    { name: 'binarized', canvas: () => preprocess(bitmap, crop, captcha.preprocess, {}), psm },
    { name: 'inverted', canvas: () => preprocess(bitmap, crop, captcha.preprocess, { invert: true }), psm },
    {
      name: 'grayscale',
      canvas: () => preprocess(bitmap, crop, captcha.preprocess, { binarize: false }),
      psm: psm === 8 ? 7 : 8,
    },
  ];

  // -Infinity, not -1: scoreCandidate() returns -1 for an empty result, so a
  // -1 seed means no variant ever wins when every attempt reads nothing — and
  // the caller gets back no preprocessed preview at all, which is exactly the
  // case where someone needs to see it to work out why.
  let best = { text: '', confidence: 0, score: -Infinity, variant: 'none', preview: '' };
  let attempts = 0;

  for (const variant of variants) {
    let canvas;
    try {
      canvas = variant.canvas();
    } catch {
      continue;
    }
    attempts += 1;
    const { raw, confidence } = await recognizeCanvas(worker, canvas, { psm: variant.psm, charset });
    const text = sanitizeOcrText(raw, { charset, expectedLength });
    const score = scoreCandidate(text, confidence, expectedLength);
    if (score > best.score) {
      best = { text, confidence, score, variant: variant.name, preview: canvasToDataUrl(canvas) };
    }
    // Good enough: right length and confident. No need to burn CPU on the rest.
    const lengthOk = expectedLength === 0 ? text.length >= 3 : text.length === expectedLength;
    if (lengthOk && confidence >= (captcha.minConfidence ?? 60) + 10) break;
  }

  bitmap.close?.();
  scheduleDispose();
  return {
    text: best.text,
    confidence: Math.round(best.confidence),
    attempts,
    variant: best.variant,
    preview: best.preview,
    engine: 'local',
  };
}

/** Sends the image to a self-hosted OCR service (ddddocr, PaddleOCR, ...). */
export async function recognizeRemote({ dataUrl, crop = null, captcha }) {
  const cfg = captcha.http || {};
  if (!cfg.url) throw new Error('http-ocr-url-missing');

  // Still pre-process: remote engines benefit from the same clean-up.
  const bitmap = await decodeImage(dataUrl);
  const canvas = preprocess(bitmap, crop, { ...captcha.preprocess, binarize: false, scale: 2 });
  bitmap.close?.();
  const cleanedDataUrl = canvasToDataUrl(canvas);
  const base64 = cleanedDataUrl.split(',')[1];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 8000);
  const headers = {};
  if (cfg.headerName && cfg.headerValue) headers[cfg.headerName] = cfg.headerValue;

  let body;
  if (cfg.format === 'form-data') {
    const form = new FormData();
    const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    form.append(cfg.fieldName || 'image', new Blob([bin], { type: 'image/png' }), 'captcha.png');
    body = form;
  } else if (cfg.format === 'raw-body') {
    body = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    headers['Content-Type'] = 'image/png';
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ [cfg.fieldName || 'image']: base64 });
  }

  try {
    const res = await fetch(cfg.url, {
      method: cfg.method || 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    let text = '';
    if (contentType.includes('application/json')) {
      const json = await res.json();
      text = String(readPath(json, cfg.responsePath) ?? '');
    } else {
      text = (await res.text()).trim();
    }
    const charset = charsetFor(captcha);
    return {
      text: sanitizeOcrText(text, { charset, expectedLength: Number(captcha.expectedLength) || 0 }),
      confidence: text ? 90 : 0,
      attempts: 1,
      variant: 'http',
      preview: cleanedDataUrl,
      engine: 'http',
    };
  } finally {
    clearTimeout(timer);
  }
}

function readPath(obj, path) {
  if (!path) return typeof obj === 'string' ? obj : obj?.result ?? obj?.text ?? obj?.data ?? obj?.code ?? '';
  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}
