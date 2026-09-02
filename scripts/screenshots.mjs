#!/usr/bin/env node
/**
 * Regenerates the screenshots used by the README.
 * Loads the unpacked extension into Chromium, drives the demo page through a
 * real fill + OCR, and captures the popup, the options page and the result.
 *
 *   node scripts/screenshots.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const OUT = path.join(ROOT, 'docs', 'images');
const BRIDGE_PORT = 8811;
const SITE_PORT = 8812;
const TOKEN = 'screenshot-token';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSite() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname;
    if (name === '/favicon.ico') return res.writeHead(204).end();
    const file = path.join(FIXTURES, name === '/' ? 'page.html' : name);
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    return res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const site = await startSite();
  const bridge = spawn(
    'node',
    [path.join(ROOT, 'bridge', 'server.mjs'), '--port', String(BRIDGE_PORT), '--token', TOKEN, '--quiet'],
    { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'avc-shot-cfg-')) } },
  );
  await sleep(700);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-shot-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    deviceScaleFactor: 2, // crisp on high-DPI displays
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const id = new URL(worker.url()).host;

    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/src/options/options.html`);
    await options.evaluate(
      async ({ port, token }) => {
        await chrome.storage.local.set({
          settings: {
            enabled: true,
            captcha: { provider: 'local', expectedLength: 4, charset: 'digits', minConfidence: 30 },
            sources: { ws: { enabled: true, url: `ws://127.0.0.1:${port}/ws`, token } },
          },
        });
      },
      { port: BRIDGE_PORT, token: TOKEN },
    );
    await sleep(2200);

    // --- the extension actually working ---------------------------------
    const page = await context.newPage();
    await page.setViewportSize({ width: 720, height: 470 });
    await page.goto(`http://127.0.0.1:${SITE_PORT}/page.html`);
    await sleep(1200);
    await fetch(`http://127.0.0.1:${BRIDGE_PORT}/sms?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '【某某科技】您的验证码是 246810，5分钟内有效，请勿泄露。' }),
    });
    for (let i = 0; i < 40; i += 1) {
      await sleep(300);
      const sms = await page.inputValue('#smsCode');
      const cap = await page.inputValue('#captcha');
      if (sms && cap) break;
    }
    // Re-trigger the chip so the status label is visible in the shot.
    await page.evaluate(() => document.getElementById('captcha')?.scrollIntoView({ block: 'center' }));
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, 'in-action.png') });
    console.log('  docs/images/in-action.png');

    // --- popup -----------------------------------------------------------
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 500 });
    await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
    await sleep(900);
    await popup.screenshot({ path: path.join(OUT, 'popup.png') });
    console.log('  docs/images/popup.png');
    await popup.close();

    // --- options ---------------------------------------------------------
    await options.setViewportSize({ width: 900, height: 760 });
    await options.reload();
    await sleep(600);
    await options.click('.tab[data-tab="captcha"]');
    await sleep(400);
    await options.screenshot({ path: path.join(OUT, 'options.png') });
    console.log('  docs/images/options.png');
  } finally {
    await context.close().catch(() => {});
    bridge.kill('SIGKILL');
    site.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
