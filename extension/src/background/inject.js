import { isInjectableUrl } from '../common/site-rules.js';
import { log } from '../common/logger.js';

/**
 * Programmatic injection.
 *
 * Manifest-declared content scripts only run when a page *loads*. Every tab that
 * was already open when the extension was installed, updated or reloaded has no
 * content script, and messaging it fails with "Receiving end does not exist".
 * Injecting on install and retrying on that error removes the "please refresh
 * every tab" step entirely.
 *
 * `loader.js` guards itself with a window flag, so re-injection is a no-op.
 */
const CONTENT_JS = ['src/content/loader.js'];
const CONTENT_CSS = ['src/content/overlay.css'];

export async function injectInto(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: CONTENT_CSS });
  } catch {
    // A frame may refuse the stylesheet; the script still matters more.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_JS });
    return true;
  } catch (err) {
    log.debug('inject', `executeScript failed for tab ${tabId}`, err);
    return false;
  }
}

/** Brings every already-open tab up to date. Failures are per-tab and silent. */
export async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return 0;
  }
  const targets = tabs.filter((t) => t.id != null && isInjectableUrl(t.url));
  const results = await Promise.all(targets.map((t) => injectInto(t.id)));
  const count = results.filter(Boolean).length;
  if (count) log.info('inject', `injected into ${count}/${targets.length} open tab(s)`);
  return count;
}

/** True when the failure is the "no content script in this tab" case. */
export function isNoReceiverError(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(String(error || ''));
}
