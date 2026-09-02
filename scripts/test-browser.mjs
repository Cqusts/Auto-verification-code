#!/usr/bin/env node
/**
 * Loads the unpacked extension into a real Chromium and exercises the whole path:
 * bridge -> service worker -> content script -> filled input, plus local OCR.
 *
 *   node scripts/test-browser.mjs [--headed]
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
const BRIDGE_PORT = 8793;
const SITE_PORT = 8794;
const TOKEN = 'browser-test-token';
const HEADED = process.argv.includes('--headed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

function startSite() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname;
    if (name === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const file = path.join(FIXTURES, name === '/' ? 'page.html' : name);
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const site = await startSite();
  const bridge = spawn(
    'node',
    [path.join(ROOT, 'bridge', 'server.mjs'), '--port', String(BRIDGE_PORT), '--token', TOKEN, '--quiet'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  await sleep(600);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: !HEADED,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  try {
    // The service worker's URL carries the generated extension id.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;
    check('extension service worker started', Boolean(extensionId), worker.url());

    const errors = [];
    context.on('weberror', (e) => errors.push(`weberror: ${e.error()}`));

    // Configure through an extension page: a partial object is deep-merged with defaults.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await options.evaluate(
      async ({ port, token }) => {
        await chrome.storage.local.set({
          settings: {
            enabled: true,
            otp: { enabled: true, autoFill: true, autoSubmit: false },
            captcha: { enabled: true, provider: 'local', expectedLength: 4, charset: 'digits', minConfidence: 30 },
            sources: { ws: { enabled: true, url: `ws://127.0.0.1:${port}/ws`, token } },
            advanced: { debug: true },
          },
        });
      },
      { port: BRIDGE_PORT, token: TOKEN },
    );
    await sleep(2500); // let the worker spin up the offscreen document and connect

    const state = await options.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'ui:get-state', payload: {} }),
    );
    check('bridge websocket connected', state?.data?.bridgeStatus?.ws === 'open', JSON.stringify(state?.data?.bridgeStatus));

    // ---- 1. SMS code lands in the single OTP input -------------------------
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
    });
    await page.goto(`http://127.0.0.1:${SITE_PORT}/page.html`);
    await page.waitForTimeout(1200);

    await fetch(`http://127.0.0.1:${BRIDGE_PORT}/sms?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '【测试平台】您的验证码是 246810，5分钟内有效，请勿泄露。' }),
    });

    let filled = '';
    for (let i = 0; i < 30 && filled !== '246810'; i += 1) {
      await page.waitForTimeout(200);
      filled = await page.inputValue('#smsCode');
    }
    check('SMS code auto-filled into #smsCode', filled === '246810', `value=${JSON.stringify(filled)}`);

    const password = await page.inputValue('#pwd');
    check('password field left untouched', password === '', `value=${JSON.stringify(password)}`);

    const submitted = await page.textContent('#sms-submitted');
    check('form not auto-submitted by default', submitted.trim() === '', `text=${submitted}`);

    // ---- 2. image CAPTCHA is read and filled -------------------------------
    let captcha = '';
    for (let i = 0; i < 60 && captcha.length !== 4; i += 1) {
      await page.waitForTimeout(500);
      captcha = await page.inputValue('#captcha');
    }
    check('CAPTCHA auto-filled with 4 characters', captcha.length === 4, `value=${JSON.stringify(captcha)}`);
    check('CAPTCHA read correctly (3947)', captcha === '3947', `value=${JSON.stringify(captcha)}`);

    // ---- 3. OCR bench on a clean image -------------------------------------
    const clean = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 170;
      canvas.height = 46;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 28px "DejaVu Sans", Arial, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('582617', 10, 24);
      return canvas.toDataURL('image/png');
    });
    const ocr = await options.evaluate(
      async (dataUrl) =>
        chrome.runtime.sendMessage({
          type: 'ui:test-ocr',
          payload: { dataUrl, overrides: { expectedLength: 6, charset: 'digits' } },
        }),
      clean,
    );
    const ocrText = ocr?.data?.text;
    check('local OCR reads a clean 6-digit image', ocrText === '582617', `got=${JSON.stringify(ocrText)} conf=${ocr?.data?.confidence}`);

    // ---- 4. split-box widget ------------------------------------------------
    await page.evaluate(() => {
      document.getElementById('smsCode').closest('fieldset').remove();
      document.getElementById('captcha').closest('fieldset').remove();
    });
    await page.waitForTimeout(900);
    await fetch(`http://127.0.0.1:${BRIDGE_PORT}/sms?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Your verification code is 135790' }),
    });
    let boxes = '';
    for (let i = 0; i < 30 && boxes !== '135790'; i += 1) {
      await page.waitForTimeout(200);
      boxes = await page.evaluate(() =>
        [...document.querySelectorAll('#boxes input')].map((el) => el.value).join(''),
      );
    }
    check('split-box OTP widget filled', boxes === '135790', `value=${JSON.stringify(boxes)}`);

    if (errors.length) console.log('  (captured page events)\n' + errors.map((e) => `    - ${e}`).join('\n'));
    // ---- 5. UI pages render cleanly ---------------------------------------
    for (const [name, file, probe] of [
      ['popup', 'src/popup/popup.html', '#btn-manual'],
      ['options', 'src/options/options.html', '#tabs'],
    ]) {
      const uiErrors = [];
      const ui = await context.newPage();
      ui.on('pageerror', (e) => uiErrors.push(String(e)));
      ui.on('console', (m) => {
        if (m.type() === 'error') uiErrors.push(m.text());
      });
      await ui.goto(`chrome-extension://${extensionId}/${file}`);
      await ui.waitForTimeout(700);
      const visible = await ui.locator(probe).isVisible().catch(() => false);
      check(`${name} page renders without errors`, visible && uiErrors.length === 0, uiErrors.slice(0, 2).join(' | '));
      if (name === 'popup') {
        // A code was delivered earlier in this run, so the fill button belongs on screen…
        const fillShown = await ui.locator('#last-actions').isVisible().catch(() => false);
        check('popup offers the last code', fillShown === true);
        // …and [hidden] must still win against the author's `display:flex`.
        const hides = await ui.evaluate(() => {
          const el = document.getElementById('last-actions');
          el.hidden = true;
          return getComputedStyle(el).display === 'none';
        });
        check('popup [hidden] actually hides', hides === true);
      }
      if (name === 'options') {
        // Panels are switched by JS, so this also proves the options script ran.
        await ui.click('.tab[data-tab="captcha"]');
        const dropzone = await ui.locator('#dropzone').isVisible().catch(() => false);
        const bound = await ui.locator('[data-path="captcha.expectedLength"]').inputValue().catch(() => '');
        check('options tabs switch and controls are bound', dropzone && bound === '4', `dropzone=${dropzone} value=${bound}`);
      }
      await ui.close();
    }

    const relevant = errors.filter((e) => !/favicon/.test(e));
    check('no uncaught extension errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));
  } finally {
    await context.close().catch(() => {});
    bridge.kill('SIGKILL');
    site.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
