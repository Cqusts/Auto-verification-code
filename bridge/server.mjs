#!/usr/bin/env node
/**
 * Local SMS bridge for the Auto Verification Code extension.
 *
 * A browser cannot read your phone's SMS. This tiny server closes that gap:
 * an SMS-forwarding app on your phone POSTs the message here, and the extension
 * picks it up over WebSocket (push) or HTTP (polling).
 *
 * Everything stays on your own machine and LAN — nothing is sent to a third party.
 *
 *   node bridge/server.mjs                    # random token, printed on start
 *   node bridge/server.mjs --port 8787 --token mysecret
 *   node bridge/server.mjs --host 127.0.0.1   # loopback only (phone cannot reach it)
 *
 * Endpoints
 *   POST /sms      body: JSON {text|content|body|msg} | form-encoded | plain text
 *   GET  /latest   -> {"messages":[{id,text,receivedAt}]}   (for HTTP polling)
 *   GET  /ws       -> WebSocket, pushes {"id","text","receivedAt"} per message
 *   GET  /         -> status page
 */
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { upgrade } from './ws.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(flag('port', process.env.AVC_PORT || 8787));
const HOST = flag('host', process.env.AVC_HOST || '0.0.0.0');
const TOKEN = flag('token', process.env.AVC_TOKEN || crypto.randomBytes(9).toString('base64url'));
const HISTORY = Number(flag('history', 50));
const QUIET = args.includes('--quiet');

const messages = [];
const sockets = new Set();

function record(text, meta = {}) {
  const entry = {
    id: crypto.randomUUID(),
    text: String(text).slice(0, 2000),
    from: meta.from ? String(meta.from).slice(0, 60) : undefined,
    receivedAt: Date.now(),
  };
  messages.unshift(entry);
  if (messages.length > HISTORY) messages.length = HISTORY;

  const payload = JSON.stringify(entry);
  for (const socket of sockets) socket.send(payload);

  if (!QUIET) {
    const preview = entry.text.replace(/\s+/g, ' ').slice(0, 70);
    console.log(`[${new Date().toLocaleTimeString()}] sms -> ${sockets.size} client(s): ${preview}`);
  }
  return entry;
}

function authorized(req, url, body) {
  if (!TOKEN) return true;
  const supplied =
    url.searchParams.get('token') ||
    req.headers['x-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    body?.token;
  if (!supplied) return false;
  // Constant-time compare so the token cannot be guessed by timing.
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Pulls the SMS text out of whatever the forwarding app decided to send. */
function parseIncoming(raw, contentType = '') {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (contentType.includes('application/json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      const pick = (o) => o?.text ?? o?.content ?? o?.body ?? o?.msg ?? o?.message ?? o?.sms;
      if (Array.isArray(json)) {
        const found = json.map(pick).find(Boolean);
        return found ? { text: String(found), token: json[0]?.token } : null;
      }
      const text = pick(json);
      return text ? { text: String(text), from: json.from ?? json.sender, token: json.token } : null;
    } catch {
      /* not JSON after all — fall through to the text paths */
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(trimmed);
    const text = params.get('text') || params.get('content') || params.get('body') || params.get('msg');
    return text ? { text, from: params.get('from'), token: params.get('token') } : null;
  }

  return { text: trimmed };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // The extension talks to us from its own origin, so allow it explicitly.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Token, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (url.pathname === '/' || url.pathname === '/status') {
    const ok = authorized(req, url, null);
    return send(
      res,
      200,
      {
        service: 'auto-verification-code bridge',
        websocket: `ws://${req.headers.host}/ws`,
        latest: `http://${req.headers.host}/latest`,
        clients: sockets.size,
        stored: messages.length,
        authorized: ok,
        hint: ok ? undefined : 'append ?token=… to authenticate',
      },
    );
  }

  if (url.pathname === '/latest' && req.method === 'GET') {
    if (!authorized(req, url, null)) return send(res, 401, { error: 'unauthorized' });
    const limit = Math.min(Number(url.searchParams.get('limit')) || 5, HISTORY);
    return send(res, 200, { messages: messages.slice(0, limit) });
  }

  if (url.pathname === '/sms' && (req.method === 'POST' || req.method === 'GET')) {
    let parsed = null;
    if (req.method === 'GET') {
      const text = url.searchParams.get('text') || url.searchParams.get('content');
      parsed = text ? { text, from: url.searchParams.get('from') } : null;
    } else {
      let raw;
      try {
        raw = await readBody(req);
      } catch (err) {
        return send(res, 413, { error: err.message });
      }
      parsed = parseIncoming(raw, req.headers['content-type'] || '');
    }
    if (!authorized(req, url, parsed)) return send(res, 401, { error: 'unauthorized' });
    if (!parsed?.text) return send(res, 400, { error: 'no message text found' });
    const entry = record(parsed.text, { from: parsed.from });
    return send(res, 200, { ok: true, id: entry.id, clients: sockets.size });
  }

  return send(res, 404, { error: 'not found' });
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  if (!authorized(req, url, null)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  const connection = upgrade(req, socket);
  if (!connection) return;

  sockets.add(connection);
  if (!QUIET) console.log(`client connected (${sockets.size} total)`);
  connection.send(JSON.stringify({ type: 'hello', stored: messages.length }));

  const heartbeat = setInterval(() => connection.ping(), 25_000);
  connection.on('close', () => {
    clearInterval(heartbeat);
    sockets.delete(connection);
    if (!QUIET) console.log(`client disconnected (${sockets.size} left)`);
  });
  // An auth frame from the extension is acknowledged but not required — the
  // handshake already carried the token.
  connection.on('message', (text) => {
    if (text.includes('"ping"')) connection.send(JSON.stringify({ type: 'pong' }));
  });
});

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const lan = localAddresses()[0] || '127.0.0.1';
  console.log('Auto Verification Code — SMS bridge');
  console.log(`  listening        http://${HOST}:${PORT}`);
  console.log(`  token            ${TOKEN}`);
  console.log('');
  console.log('  In the extension options → 短信来源:');
  console.log(`    WebSocket URL  ws://127.0.0.1:${PORT}/ws`);
  console.log(`    HTTP URL       http://127.0.0.1:${PORT}/latest`);
  console.log(`    token          ${TOKEN}`);
  console.log('');
  console.log('  On your phone, forward verification SMS to:');
  console.log(`    POST http://${lan}:${PORT}/sms?token=${TOKEN}`);
  console.log(`    body {"text":"[Bank] Your code is 123456"}`);
  console.log('');
  console.log('  Try it now:');
  console.log(`    curl -X POST "http://127.0.0.1:${PORT}/sms?token=${TOKEN}" \\`);
  console.log(`         -H 'Content-Type: application/json' \\`);
  console.log(`         -d '{"text":"【测试】您的验证码是 123456，5分钟内有效"}'`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const socket of sockets) socket.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
