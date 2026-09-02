import { MSG, LIMITS } from '../common/constants.js';
import { sendToRuntime } from '../common/messaging.js';
import { sleep } from '../common/util.js';
import { topViewportRect, isInViewport, isVisible } from './dom-utils.js';
import { typeInto, submitFor } from './fill.js';
import { flashField } from './overlay.js';

function waitForLoad(img, timeoutMs = 4000) {
  if (img.complete && img.naturalWidth) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      resolve(ok);
    };
    const onLoad = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
  });
}

function backgroundImageUrl(el) {
  const match = /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
  return match ? match[1] : null;
}

/**
 * Reads the CAPTCHA's pixels *without re-requesting the URL*.
 *
 * This is the whole ballgame: nearly every CAPTCHA endpoint issues a fresh
 * challenge on each GET, so downloading the image again would invalidate the one
 * the user is looking at. Order of preference:
 *   1. draw the already-decoded element onto a canvas (free, exact)
 *   2. screenshot the tab and crop (exact, needs the element on screen)
 *   3. hand the URL to the background as a last resort
 */
export async function grabImage(image) {
  const { el, kind } = image;
  if (!isVisible(el)) return { error: 'image-hidden' };

  if (kind === 'img') await waitForLoad(el);

  try {
    if (kind === 'canvas') {
      return { dataUrl: el.toDataURL('image/png') };
    }
    if (kind === 'img') {
      const width = el.naturalWidth || Math.round(el.getBoundingClientRect().width);
      const height = el.naturalHeight || Math.round(el.getBoundingClientRect().height);
      if (width > 0 && height > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(el, 0, 0, width, height);
        // Throws for a cross-origin source; that is the signal to fall through.
        return { dataUrl: canvas.toDataURL('image/png') };
      }
    }
    if (kind === 'background') {
      const url = backgroundImageUrl(el);
      if (url?.startsWith('data:')) return { dataUrl: url };
    }
  } catch {
    /* tainted canvas — fall through to the screenshot path */
  }

  const rect = topViewportRect(el);
  if (rect && isInViewport(el)) {
    return { rect, devicePixelRatio: window.devicePixelRatio || 1 };
  }

  const src = kind === 'background' ? backgroundImageUrl(el) : el.currentSrc || el.src;
  if (src && !src.startsWith('data:')) return { imageUrl: new URL(src, location.href).toString() };
  return { error: 'no-pixels' };
}

/** Clicking the picture is the near-universal "give me another one" gesture. */
function refreshCaptcha(image) {
  const { el } = image;
  const clickable = el.closest('a, button, [role="button"]') || el;
  clickable.click();
}

export class CaptchaSolver {
  constructor({ chip, getSettings }) {
    this.chip = chip;
    this.getSettings = getSettings;
    this.busy = new WeakSet();
    this.solvedFor = new WeakMap();
  }

  /**
   * @param {{input:Element, image:{el:Element, kind:string}}} target
   * @param {{manual?:boolean}} [options]
   */
  async solve(target, { manual = false } = {}) {
    const { input, image } = target;
    const settings = this.getSettings();
    if (!settings?.captcha?.enabled && !manual) return { ok: false, reason: 'disabled' };
    if (this.busy.has(input)) return { ok: false, reason: 'busy' };

    this.busy.add(input);
    try {
      const retries = Math.min(settings.captcha.maxRetries ?? 2, LIMITS.MAX_OCR_RETRIES);
      const maxAttempts = manual ? 1 : Math.max(1, retries + 1);
      let last = null;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (attempt > 0) {
          this.chip.show({ anchor: input, state: 'working', text: '换一张再试… / retrying' });
          refreshCaptcha(image);
          await sleep(700);
        }
        this.chip.show({ anchor: input, state: 'working', text: '识别验证码… / reading CAPTCHA' });

        const grabbed = await grabImage(image);
        if (grabbed.error) {
          this.chip.show({ anchor: input, state: 'error', text: `无法读取图片 (${grabbed.error})`, autoHideMs: 4000 });
          return { ok: false, reason: grabbed.error };
        }

        const res = await sendToRuntime(MSG.REQUEST_OCR, grabbed);
        if (!res.ok) {
          this.chip.show({ anchor: input, state: 'error', text: `识别失败: ${res.error}`, autoHideMs: 5000 });
          return { ok: false, reason: res.error };
        }

        last = res.data;
        const expected = Number(settings.captcha.expectedLength) || 0;
        const lengthOk = expected === 0 ? last.text.length >= 3 : last.text.length === expected;
        const confident = last.confidence >= (settings.captcha.minConfidence ?? 60);

        if (last.text && lengthOk && (confident || manual)) {
          this.solvedFor.set(image.el, last.text);
          if (settings.captcha.autoFill === false && !manual) {
            // The user wants to approve each answer rather than have it typed in.
            this.offer(input, last, settings);
            return { ok: true, offered: true, ...last };
          }
          await this.apply(input, last, settings);
          return { ok: true, ...last };
        }
      }

      // Out of attempts: offer what we have rather than silently giving up.
      if (last?.text) {
        this.offer(input, last, settings, 'error');
      } else {
        this.chip.show({ anchor: input, state: 'error', text: '未能识别验证码', autoHideMs: 4000 });
      }
      return { ok: false, reason: 'low-confidence', ...(last || {}) };
    } finally {
      this.busy.delete(input);
    }
  }

  /** Shows the answer and lets the user accept it with one click. */
  offer(input, result, settings, state = 'waiting') {
    this.chip.show({
      anchor: input,
      state,
      text: `识别为 ${result.text}（置信度 ${result.confidence}%）`,
      action: { label: '采用', onClick: () => this.apply(input, result, settings) },
      autoHideMs: 12000,
    });
  }

  async apply(input, result, settings) {
    await typeInto(input, result.text);
    flashField(input);
    this.chip.show({
      anchor: input,
      state: 'done',
      text: `已填入 ${result.text}（${result.confidence}%）`,
      autoHideMs: 3500,
    });
    if (settings.captcha.autoSubmit) submitFor(input);
  }

  /** Have we already produced an answer for the currently displayed image? */
  hasSolved(image) {
    return this.solvedFor.has(image.el);
  }

  forget(image) {
    this.solvedFor.delete(image.el);
  }
}
