import { log } from '../common/logger.js';

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Screenshot of the visible viewport. This is the only capture path that is
 * guaranteed *not* to re-request the CAPTCHA URL — most CAPTCHA endpoints mint a
 * new challenge on every GET, so re-fetching would invalidate what the user sees.
 */
export async function captureVisibleTab(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
      format: 'png',
    });
  } catch (err) {
    log.warn('image', 'captureVisibleTab failed', err);
    return null;
  }
}

/**
 * Last-resort fetch of an image URL from the extension origin.
 * `cache: 'force-cache'` prefers the copy the page already downloaded, which keeps
 * single-use CAPTCHA URLs intact whenever the response was cacheable.
 */
export async function fetchImageAsDataUrl(url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      cache: 'force-cache',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || 'image/png';
    if (!/^image\//i.test(type)) throw new Error(`not an image: ${type}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) throw new Error('empty body');
    return `data:${type};base64,${arrayBufferToBase64(buf)}`;
  } catch (err) {
    log.warn('image', 'fetchImageAsDataUrl failed', { url, error: String(err?.message || err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
