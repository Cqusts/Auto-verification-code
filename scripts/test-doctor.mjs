#!/usr/bin/env node
/** The doctor has to be right about the two states it distinguishes. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8841;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

const cfg = mkdtempSync(path.join(os.tmpdir(), 'avc-doctor-'));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(cfg, 'config') };
const doctor = (port) =>
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'doctor.mjs'), '--port', String(port)], {
    cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

// --- nothing listening ------------------------------------------------------
{
  const out = doctor(PORT);
  check('reports the bridge as not running', out.includes('没有响应'));
  check('tells the user how to start it', out.includes('start-bridge'));
  check('still suggests an address for the phone', /http:\/\/\d+\.\d+\.\d+\.\d+:\d+/.test(out));
  check('never claims success while it is down', !out.includes('正在运行'));
}

// --- bridge up --------------------------------------------------------------
{
  const child = spawn('node', [path.join(ROOT, 'bridge', 'server.mjs'), '--port', String(PORT), '--quiet'], {
    stdio: 'ignore', env,
  });
  await sleep(1000);
  try {
    const out = doctor(PORT);
    check('reports the bridge as running', out.includes('正在运行'));
    check('notices the extension is not connected', out.includes('扩展还没连上'));
    check('prints the token', out.includes('令牌'));
    check('hands over one exact URL to open on the phone', out.includes(`:${PORT}/status`));
    check('explains both outcomes of that test', out.includes('看到一段 JSON') && out.includes('转圈到超时'));
  } finally {
    child.kill('SIGKILL');
  }
}

rmSync(cfg, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
