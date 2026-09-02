#!/usr/bin/env node
/** End-to-end check of bridge/server.mjs: HTTP POST -> /latest and -> WebSocket push. */
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const TOKEN = 'test-token-123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

/** Bare-bones client handshake + frame reader, mirroring what the browser does. */
function wsConnect(port, token) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        [
          `GET /ws?token=${token} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'),
      );
    });

    const frames = [];
    let handshaken = false;
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString();
        if (!head.includes('101')) {
          reject(new Error(`handshake failed: ${head.split('\r\n')[0]}`));
          return;
        }
        handshaken = true;
        buffer = buffer.subarray(end + 4);
        resolve({ socket, frames });
      }
      // Server frames are unmasked; payloads here are always small.
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + len) return;
        const payload = buffer.subarray(offset, offset + len).toString('utf8');
        buffer = buffer.subarray(offset + len);
        if (opcode === 0x1) frames.push(payload);
      }
    });
    socket.on('error', reject);
  });
}

async function main() {
  const server = spawn('node', [path.join(ROOT, 'bridge', 'server.mjs'), '--port', String(PORT), '--token', TOKEN, '--quiet'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await sleep(700);

  try {
    const status = await fetch(`http://127.0.0.1:${PORT}/status?token=${TOKEN}`).then((r) => r.json());
    check('status endpoint responds', status.service?.includes('bridge'), JSON.stringify(status));

    const noAuth = await fetch(`http://127.0.0.1:${PORT}/latest`);
    check('unauthenticated /latest is rejected', noAuth.status === 401, `got ${noAuth.status}`);

    const ws = await wsConnect(PORT, TOKEN);
    await sleep(200);
    check('websocket handshake + hello frame', ws.frames.some((f) => f.includes('hello')), JSON.stringify(ws.frames));

    const body = { text: '【测试】您的验证码是 123456，5分钟内有效' };
    const post = await fetch(`http://127.0.0.1:${PORT}/sms?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    check('POST /sms accepted', post.ok === true, JSON.stringify(post));

    await sleep(250);
    check('message pushed over websocket', ws.frames.some((f) => f.includes('123456')), JSON.stringify(ws.frames));

    const latest = await fetch(`http://127.0.0.1:${PORT}/latest?token=${TOKEN}`).then((r) => r.json());
    check('GET /latest returns the message', latest.messages?.[0]?.text === body.text, JSON.stringify(latest));

    const plain = await fetch(`http://127.0.0.1:${PORT}/sms?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'Your code is 998877',
    }).then((r) => r.json());
    check('plain-text body accepted', plain.ok === true, JSON.stringify(plain));

    const form = await fetch(`http://127.0.0.1:${PORT}/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ content: 'code 5566', token: TOKEN }).toString(),
    }).then((r) => r.json());
    check('form-encoded body accepted', form.ok === true, JSON.stringify(form));

    const badToken = await fetch(`http://127.0.0.1:${PORT}/sms?token=wrong`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'code 1111' }),
    });
    check('wrong token rejected', badToken.status === 401, `got ${badToken.status}`);

    ws.socket.destroy();

    // A second instance on the same port must explain itself, not throw a stack trace.
    const clash = await new Promise((resolve) => {
      const child = spawn('node', [path.join(ROOT, 'bridge', 'server.mjs'), '--port', String(PORT)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', (code) => resolve({ code, out }));
    });
    check('port clash exits cleanly', clash.code === 1, `exit=${clash.code}`);
    check('port clash prints no stack trace', !/at Server\.|node:net:/.test(clash.out), clash.out.slice(0, 120));
    check('port clash recognises our own bridge', clash.out.includes('已经有一个'), clash.out.slice(0, 160));
    check('port clash suggests another port', clash.out.includes('--port'), clash.out.slice(0, 160));
  } finally {
    server.kill('SIGTERM');
    await sleep(200);
    server.kill('SIGKILL');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
