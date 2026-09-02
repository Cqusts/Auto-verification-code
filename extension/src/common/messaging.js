/**
 * chrome.runtime messaging wrappers.
 *
 * Every call resolves to `{ ok, data }` / `{ ok:false, error }` instead of throwing,
 * because a missing receiver (no content script, torn-down tab, sleeping worker) is
 * the normal case here — not an exception.
 */

export async function sendToRuntime(type, payload = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ type, payload });
    return res ?? { ok: false, error: 'no-response' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function sendToTab(tabId, type, payload = {}, { frameId } = {}) {
  try {
    const options = frameId === undefined ? undefined : { frameId };
    const res = await chrome.tabs.sendMessage(tabId, { type, payload }, options);
    return res ?? { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Registers an async message handler.
 * `handlers` maps message type -> async (payload, sender) => data
 */
export function registerHandlers(handlers) {
  const listener = (message, sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(message.payload ?? {}, sender))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true; // keep the channel open for the async response
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
