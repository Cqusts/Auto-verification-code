import { OFFSCREEN_PATH } from '../common/constants.js';
import { log } from '../common/logger.js';

let creating = null;

export async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

/** Creates the offscreen document if needed; concurrent callers share one attempt. */
export async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (creating) {
    await creating.catch(() => {});
    return hasOffscreen();
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS', 'BLOBS', 'CLIPBOARD'],
    justification: 'Runs the bundled offline OCR engine and keeps the local SMS bridge connection open.',
  });
  try {
    await creating;
    log.debug('offscreen', 'document created');
    return true;
  } catch (err) {
    // A parallel creation may have won the race; that is success, not failure.
    if (String(err?.message || '').includes('Only a single offscreen')) return true;
    log.error('offscreen', 'createDocument failed', err);
    return false;
  } finally {
    creating = null;
  }
}

export async function closeOffscreen() {
  if (!(await hasOffscreen())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (err) {
    log.warn('offscreen', 'closeDocument failed', err);
  }
}

/** Sends a message to the offscreen document, creating it first. */
export async function callOffscreen(type, payload = {}, { timeoutMs = 30000 } = {}) {
  const ready = await ensureOffscreen();
  if (!ready) return { ok: false, error: 'offscreen-unavailable' };
  const request = chrome.runtime.sendMessage({ type, payload }).catch((err) => ({
    ok: false,
    error: err?.message || String(err),
  }));
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs));
  return (await Promise.race([request, timeout])) ?? { ok: false, error: 'no-response' };
}
