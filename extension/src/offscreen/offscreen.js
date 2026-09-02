import { MSG, OCR_PROVIDER } from '../common/constants.js';
import { registerHandlers } from '../common/messaging.js';
import { BridgeClient, extractMessages } from './bridge-client.js';
import { recognize, recognizeRemote } from './ocr-engine.js';

const bridge = new BridgeClient({
  onMessage: ({ text, source }) => {
    chrome.runtime.sendMessage({ type: MSG.BRIDGE_MESSAGE, payload: { text, source } }).catch(() => {});
  },
  onStatus: (status) => {
    chrome.runtime.sendMessage({ type: MSG.BRIDGE_STATUS, payload: status }).catch(() => {});
  },
});

/**
 * A service worker sleeps after ~30s idle, which would drop the bridge socket.
 * Regular traffic on a long-lived port keeps it awake while a source is enabled.
 */
let keepAlivePort = null;
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  const connect = () => {
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'avc-keepalive' });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
      });
    } catch {
      keepAlivePort = null;
    }
  };
  connect();
  keepAliveTimer = setInterval(() => {
    if (!keepAlivePort) connect();
    try {
      keepAlivePort?.postMessage({ t: Date.now() });
    } catch {
      keepAlivePort = null;
    }
  }, 20_000);
}

function stopKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  try {
    keepAlivePort?.disconnect();
  } catch {
    /* already gone */
  }
  keepAlivePort = null;
}

registerHandlers({
  [MSG.BRIDGE_CONFIGURE]: async (payload) => {
    bridge.configure({ ws: payload.ws, http: payload.http });
    const wantsBridge = Boolean(payload.ws?.enabled || payload.http?.enabled);
    if (wantsBridge && payload.keepAlive !== false) startKeepAlive();
    else stopKeepAlive();
    return { status: bridge.status };
  },

  [MSG.BRIDGE_STATUS]: async () => ({ status: bridge.status }),

  /** One-shot connectivity probe used by the options page. */
  [MSG.BRIDGE_TEST]: async (payload) => {
    const { kind, config } = payload;
    if (kind === 'http') {
      const started = Date.now();
      const body = await BridgeClient.fetchHttp({ ...config, timeoutMs: 8000 });
      const messages = extractMessages(body, config.responsePath);
      return {
        ok: true,
        ms: Date.now() - started,
        found: messages.length,
        sample: messages[0]?.text?.slice(0, 160) || '',
      };
    }
    if (kind === 'ws') {
      return new Promise((resolve) => {
        let socket;
        const done = (result) => {
          clearTimeout(timer);
          try {
            socket?.close();
          } catch {
            /* ignore */
          }
          resolve(result);
        };
        const timer = setTimeout(() => done({ ok: false, error: 'timeout (10s)' }), 10_000);
        try {
          const url = new URL(config.url);
          if (config.token && !url.searchParams.has('token')) url.searchParams.set('token', config.token);
          socket = new WebSocket(url.toString());
        } catch (err) {
          done({ ok: false, error: String(err?.message || err) });
          return;
        }
        socket.onopen = () => done({ ok: true, ms: 0 });
        socket.onerror = () => done({ ok: false, error: 'connection refused or blocked' });
      });
    }
    throw new Error('unknown-test-kind');
  },

  [MSG.OCR_RUN]: async (payload) => {
    const captcha = payload.captcha || {};
    if (captcha.provider === OCR_PROVIDER.HTTP) {
      return recognizeRemote({ dataUrl: payload.dataUrl, crop: payload.crop, captcha });
    }
    return recognize({ dataUrl: payload.dataUrl, crop: payload.crop, captcha });
  },
});

chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_READY, payload: {} }).catch(() => {});
