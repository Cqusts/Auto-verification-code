/**
 * Classic content script whose only job is to pull in the real (ES module)
 * implementation. Content scripts cannot be modules themselves, but a dynamic
 * import of a web-accessible resource runs in this isolated world with full
 * chrome.* access — which lets the page code share `src/common/`.
 */
(() => {
  if (window.__AVC_BOOTSTRAPPED__) return;
  window.__AVC_BOOTSTRAPPED__ = true;
  const url = chrome.runtime.getURL('src/content/main.js');
  import(url).catch((err) => {
    console.error('[AVC] failed to load content module', err);
  });
})();
