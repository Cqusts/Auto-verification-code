import { SOURCE, LIMITS } from '../common/constants.js';
import { safeJson, getPath, clamp } from '../common/util.js';

/**
 * Pulls SMS text out of whatever shape the user's forwarder sends.
 * Accepts a bare string, an object, or a list of either.
 */
export function extractMessages(payload, responsePath = '') {
  const rooted = responsePath ? getPath(payload, responsePath) : payload;
  const out = [];

  const visit = (value, depth = 0) => {
    if (value == null || depth > 4) return;
    if (typeof value === 'string') {
      const asJson = value.trim().startsWith('{') || value.trim().startsWith('[') ? safeJson(value) : null;
      if (asJson) visit(asJson, depth + 1);
      else if (value.trim()) out.push({ id: null, text: value.trim(), at: null, direct: false });
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((v) => visit(v, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;

    for (const key of ['messages', 'data', 'list', 'items', 'result', 'results', 'sms']) {
      if (Array.isArray(value[key])) {
        value[key].slice(0, 20).forEach((v) => visit(v, depth + 1));
        return;
      }
    }

    const text =
      value.text ?? value.body ?? value.message ?? value.content ?? value.sms ?? value.msg ?? value.detail;
    // A forwarder that already parsed the code can send it directly.
    const direct = value.code ?? value.otp ?? value.verificationCode;
    const at = value.receivedAt ?? value.timestamp ?? value.time ?? value.date ?? null;
    const id = value.id ?? value.messageId ?? value.uuid ?? null;

    if (typeof text === 'string' && text.trim()) {
      out.push({ id: id != null ? String(id) : null, text: text.trim(), at, direct: false });
    } else if (direct != null && String(direct).trim()) {
      out.push({ id: id != null ? String(id) : null, text: String(direct).trim(), at, direct: true });
    }
  };

  visit(rooted);
  return out;
}

function hashKey(message) {
  if (message.id) return `id:${message.id}`;
  const stamp = message.at ? String(message.at) : '';
  return `t:${stamp}:${message.text.slice(0, 80)}`;
}

/**
 * Owns the connection to the user's local SMS bridge.
 * Lives in the offscreen document because a service worker cannot hold timers
 * or a socket open reliably.
 */
export class BridgeClient {
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.wsConfig = null;
    this.httpConfig = null;
    this.httpTimer = null;
    this.reconnectTimer = null;
    this.attempt = 0;
    this.seen = new Set();
    this.seenOrder = [];
    this.status = { ws: 'off', http: 'off', lastError: '', lastMessageAt: 0 };
    this.stopped = false;
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  remember(key) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > 200) this.seen.delete(this.seenOrder.shift());
    return true;
  }

  emit(messages, source) {
    for (const message of messages) {
      if (!this.remember(hashKey(message))) continue;
      this.setStatus({ lastMessageAt: Date.now() });
      this.onMessage?.({ text: message.text, source, direct: message.direct });
    }
  }

  configure({ ws, http }) {
    this.stopped = false;
    this.configureWs(ws);
    this.configureHttp(http);
  }

  // --- WebSocket ----------------------------------------------------------

  configureWs(config) {
    const next = config && config.enabled ? config : null;
    const same = JSON.stringify(next) === JSON.stringify(this.wsConfig);
    if (same && this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.closeWs();
    this.wsConfig = next;
    if (next) this.connectWs();
    else this.setStatus({ ws: 'off' });
  }

  buildWsUrl(config) {
    const url = new URL(config.url);
    if (config.token && !url.searchParams.has('token')) url.searchParams.set('token', config.token);
    return url.toString();
  }

  connectWs() {
    if (this.stopped || !this.wsConfig) return;
    let socket;
    try {
      socket = new WebSocket(this.buildWsUrl(this.wsConfig));
    } catch (err) {
      this.setStatus({ ws: 'error', lastError: String(err?.message || err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    this.setStatus({ ws: 'connecting' });

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus({ ws: 'open', lastError: '' });
      if (this.wsConfig.token) {
        try {
          socket.send(JSON.stringify({ type: 'auth', token: this.wsConfig.token }));
        } catch {
          /* server may not want an auth frame */
        }
      }
    };
    socket.onmessage = (event) => {
      const payload = typeof event.data === 'string' ? safeJson(event.data, event.data) : null;
      if (payload == null) return;
      this.emit(extractMessages(payload), SOURCE.BRIDGE_WS);
    };
    socket.onerror = () => {
      this.setStatus({ ws: 'error', lastError: 'socket error' });
    };
    socket.onclose = () => {
      if (this.ws === socket) this.ws = null;
      if (this.wsConfig && !this.stopped) {
        this.setStatus({ ws: 'error' });
        this.scheduleReconnect();
      } else {
        this.setStatus({ ws: 'off' });
      }
    };
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.stopped || !this.wsConfig) return;
    const base = clamp(Number(this.wsConfig.reconnectSeconds) || 5, 2, 60) * 1000;
    const delay = Math.min(base * 2 ** Math.min(this.attempt, 4), 60_000);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connectWs(), delay);
  }

  closeWs() {
    clearTimeout(this.reconnectTimer);
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  }

  // --- HTTP polling -------------------------------------------------------

  configureHttp(config) {
    const next = config && config.enabled && config.url ? config : null;
    clearInterval(this.httpTimer);
    this.httpTimer = null;
    this.httpConfig = next;
    if (!next) {
      this.setStatus({ http: 'off' });
      return;
    }
    const seconds = clamp(Number(next.intervalSeconds) || 5, LIMITS.MIN_POLL_SECONDS, 3600);
    this.setStatus({ http: 'polling' });
    this.pollHttp();
    this.httpTimer = setInterval(() => this.pollHttp(), seconds * 1000);
  }

  async pollHttp() {
    const config = this.httpConfig;
    if (!config || this.stopped) return;
    try {
      const result = await BridgeClient.fetchHttp(config);
      this.setStatus({ http: 'ok', lastError: '' });
      this.emit(extractMessages(result, config.responsePath), SOURCE.BRIDGE_HTTP);
    } catch (err) {
      this.setStatus({ http: 'error', lastError: String(err?.message || err) });
    }
  }

  static async fetchHttp(config) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs || 6000);
    const headers = { Accept: 'application/json, text/plain;q=0.9' };
    if (config.headerName && config.headerValue) headers[config.headerName] = config.headerValue;
    try {
      const res = await fetch(config.url, { headers, signal: controller.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return safeJson(text, text);
    } finally {
      clearTimeout(timer);
    }
  }

  stop() {
    this.stopped = true;
    this.closeWs();
    clearInterval(this.httpTimer);
    this.httpTimer = null;
    this.setStatus({ ws: 'off', http: 'off' });
  }
}
