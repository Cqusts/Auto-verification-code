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
const OCR_PORT = 8795;
const TOKEN = 'browser-test-token';
const HEADED = process.argv.includes('--headed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

/** Speaks exactly the contract documented for ocr-server/server.py. */
function startMockOcr(port, received) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/ocr' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.contentType = req.headers['content-type'] || '';
      try {
        received.payload = JSON.parse(body);
      } catch {
        received.payload = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'A7c2' }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

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

    // ---- 3b. despeckle must run before upscaling ---------------------------
    // Pure salt-and-pepper with no glyphs: a working noise filter leaves the
    // preview essentially blank. Cleaning after the upscale cannot, because
    // each noisy pixel has become a solid scale×scale block.
    const noisy = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 90;
      canvas.height = 34;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Deterministic PRNG so the assertion cannot flake.
      let seed = 20260902;
      const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      ctx.fillStyle = '#000';
      for (let i = 0; i < 260; i += 1) {
        ctx.fillRect(Math.floor(rand() * canvas.width), Math.floor(rand() * canvas.height), 1, 1);
      }
      return canvas.toDataURL('image/png');
    });
    const noiseRes = await options.evaluate(
      async (dataUrl) =>
        chrome.runtime.sendMessage({ type: 'ui:test-ocr', payload: { dataUrl, overrides: { expectedLength: 4 } } }),
      noisy,
    );
    const darkFraction = await page.evaluate(
      (preview) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const cx = c.getContext('2d');
            cx.drawImage(img, 0, 0);
            const { data } = cx.getImageData(0, 0, c.width, c.height);
            let dark = 0;
            for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark += 1;
            resolve(dark / (data.length / 4));
          };
          img.onerror = () => resolve(1);
          img.src = preview;
        }),
      noiseRes?.data?.preview,
    );
    // A blank result must still hand back the preprocessed image: that picture is
    // the only way to tell "the filter ate everything" from "the engine failed".
    check('a preview is returned even when nothing is recognised', Boolean(noiseRes?.data?.preview));
    check(
      'noise is removed before upscaling',
      darkFraction < 0.02,
      `dark=${(darkFraction * 100).toFixed(1)}%`,
    );

    // ---- 3c. the self-hosted OCR contract ----------------------------------
    // ocr-server/server.py cannot run here (no flask), so pin the half we own:
    // what the extension sends, and how it reads the reply back.
    const ocrReceived = {};
    const mockOcr = await startMockOcr(OCR_PORT, ocrReceived);
    try {
      const remote = await options.evaluate(
        async ({ dataUrl, url }) =>
          chrome.runtime.sendMessage({
            type: 'ui:test-ocr',
            payload: {
              dataUrl,
              overrides: {
                provider: 'http',
                charset: 'alnum',
                expectedLength: 4,
                http: {
                  url,
                  method: 'POST',
                  format: 'json-base64',
                  fieldName: 'image',
                  responsePath: 'result',
                  timeoutMs: 8000,
                },
              },
            },
          }),
        { dataUrl: clean, url: `http://127.0.0.1:${OCR_PORT}/ocr` },
      );
      check('http OCR posts JSON', ocrReceived.contentType.includes('application/json'), ocrReceived.contentType);
      check('http OCR sends base64 under the configured field', typeof ocrReceived.payload?.image === 'string' && ocrReceived.payload.image.length > 100);
      check('http OCR sends no data: prefix', !String(ocrReceived.payload?.image || '').startsWith('data:'));
      check('http OCR reads the configured response path', remote?.data?.text === 'A7c2', JSON.stringify(remote?.data));
    } finally {
      mockOcr.close();
    }

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
    // ---- 4b. recall on pages whose markup names nothing --------------------
    {
      const hard = await context.newPage();
      await hard.goto(`http://127.0.0.1:${SITE_PORT}/hard.html`);
      await hard.waitForTimeout(1200);

      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/sms?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '【测试】您的验证码是 778899，5分钟内有效' }),
      });

      let picked = '';
      for (let i = 0; i < 30 && !picked; i += 1) {
        await hard.waitForTimeout(200);
        picked = await hard.inputValue('#input3');
      }
      check('an unnamed field beside 获取验证码 is found', picked === '778899', `value=${JSON.stringify(picked)}`);

      check('the unlabelled field above it is left alone', (await hard.inputValue('#input2')) === '');
      check('the phone field is never filled', (await hard.inputValue('input[name="mobile"]')) === '');

      // Section C has no signal at all; only a manual pick can reach it.
      const before = await hard.inputValue('#mystery');
      check('a field with no signal at all is not guessed', before === '');

      // Simulate what the popup does: enter pick mode, then click the field.
      // The request has to come from an extension page — a service worker does
      // not receive its own runtime messages.
      await hard.bringToFront();
      await hard.waitForTimeout(200);
      const started = await options.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'ui:pick-active-tab', payload: {} }),
      );
      check('pick mode starts without waiting for the click', started?.data?.started === true, JSON.stringify(started));
      await hard.waitForTimeout(500);
      check('pick mode shows a banner', await hard.locator('.avc-pick-banner').isVisible().catch(() => false));

      // Clicking something that cannot be filled must say so, not sit silent.
      await hard.click('legend');
      await hard.waitForTimeout(300);
      check('clicking a non-input explains itself',
        (await hard.locator('.avc-pick-banner--warn').count()) > 0);

      await hard.click('#mystery');
      await hard.waitForTimeout(600);
      check('the page confirms the pick', (await hard.locator('.avc-pick-banner--ok').count()) > 0);
      check('the override is remembered for this host',
        (await options.evaluate(async () => {
          const got = await chrome.storage.local.get('settings');
          return got.settings?.sites?.fieldOverrides?.['127.0.0.1']?.otp;
        })) === '#mystery');

      await hard.reload();
      await hard.waitForTimeout(1200);
      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/sms?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '【测试】您的验证码是 445566，5分钟内有效' }),
      });
      let manual = '';
      for (let i = 0; i < 30 && !manual; i += 1) {
        await hard.waitForTimeout(200);
        manual = await hard.inputValue('#mystery');
      }
      check('the picked field is used after a reload', manual === '445566', `value=${JSON.stringify(manual)}`);
      await hard.close();
    }

    // ---- 4b2. an SPA field whose only clue is its placeholder ---------------
    // "验证码" alone is ambiguous only while an image CAPTCHA is possible; with
    // no image on the page the label can only mean the SMS kind.
    {
      const spa = await context.newPage();
      await spa.goto(`http://127.0.0.1:${SITE_PORT}/spa.html`);
      await spa.waitForTimeout(1200);
      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/sms?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '【测试】您的验证码是 991133，5分钟内有效' }),
      });
      let spaValue = '';
      for (let i = 0; i < 30 && !spaValue; i += 1) {
        await spa.waitForTimeout(200);
        spaValue = await spa.inputValue('input[placeholder="请输入验证码"]');
      }
      check('a 验证码 placeholder alone is enough', spaValue === '991133', `value=${JSON.stringify(spaValue)}`);
      check('the phone field beside it stays empty',
        (await spa.inputValue('input[placeholder="请输入手机号"]')) === '');
      await spa.close();
    }

    // ---- 4b3. the user's own phone number -----------------------------------
    // Writing personal data into a page: it must land only where asked, and
    // nowhere near a password, an ID number or the code box.
    {
      await options.evaluate(async () => {
        const got = await chrome.storage.local.get('settings');
        const settings = got.settings || {};
        settings.phone = { enabled: true, number: '13800138000', skipNonEmpty: true, fillOnce: true };
        await chrome.storage.local.set({ settings });
      });

      const phone = await context.newPage();
      await phone.goto(`http://127.0.0.1:${SITE_PORT}/phone.html`);
      await phone.waitForTimeout(1500);

      for (const id of ['#phone1', '#phone2', '#phone3']) {
        check(`phone number fills ${id}`, (await phone.inputValue(id)) === '13800138000', await phone.inputValue(id));
      }
      for (const [id, why] of [
        ['#notCode', 'the SMS code box'],
        ['#notPwd', 'a password field'],
        ['#notMail', 'an email field'],
        ['#notSearch', 'a search box'],
        ['#notId', 'an ID-number field'],
      ]) {
        check(`phone number never touches ${why}`, (await phone.inputValue(id)) === '', await phone.inputValue(id));
      }
      check('an already-filled phone field is left alone',
        (await phone.inputValue('#prefilled')) === '19900000000');

      // Clearing by hand must stick rather than being re-filled on the next scan.
      await phone.fill('#phone1', '');
      await phone.evaluate(() => document.body.appendChild(document.createElement('span')));
      await phone.waitForTimeout(1200);
      check('a hand-cleared field is not re-filled', (await phone.inputValue('#phone1')) === '');

      // And with no number saved the feature is completely inert.
      await options.evaluate(async () => {
        const got = await chrome.storage.local.get('settings');
        const settings = got.settings || {};
        settings.phone = { ...settings.phone, number: '' };
        await chrome.storage.local.set({ settings });
      });
      const phone2 = await context.newPage();
      await phone2.goto(`http://127.0.0.1:${SITE_PORT}/phone.html`);
      await phone2.waitForTimeout(1500);
      check('no saved number means nothing is filled', (await phone2.inputValue('#phone1')) === '');
      await phone2.close();
      await phone.close();
    }

    // ---- 4c. the login form lives in an iframe -----------------------------
    // The shape used by plenty of SPA/SSO login pages. Pick mode has to run in
    // every frame, or the banner shows on top and clicking does nothing.
    {
      await options.evaluate(async () => {
        const got = await chrome.storage.local.get('settings');
        const settings = got.settings || {};
        settings.sites = { ...(settings.sites || {}), fieldOverrides: {} };
        await chrome.storage.local.set({ settings });
      });

      const framed = await context.newPage();
      await framed.goto(`http://127.0.0.1:${SITE_PORT}/framed.html`);
      await framed.waitForTimeout(1200);
      await framed.bringToFront();
      await framed.waitForTimeout(200);

      await options.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pick-active-tab', payload: {} }));
      await framed.waitForTimeout(600);

      const frame = framed.frames().find((f) => f.url().includes('inner.html'));
      check('pick mode reaches the iframe', Boolean(frame) && (await frame.locator('.avc-pick-banner').count()) > 0);

      await frame.click('#innerCode');
      await framed.waitForTimeout(700);
      check('picking inside an iframe is stored',
        (await options.evaluate(async () => {
          const got = await chrome.storage.local.get('settings');
          return got.settings?.sites?.fieldOverrides?.['127.0.0.1']?.otp;
        })) === '#innerCode');

      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/sms?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '【测试】您的验证码是 224466，5分钟内有效' }),
      });
      let inFrame = '';
      for (let i = 0; i < 30 && !inFrame; i += 1) {
        await framed.waitForTimeout(200);
        inFrame = await frame.inputValue('#innerCode');
      }
      check('a code fills a picked field inside an iframe', inFrame === '224466', `value=${JSON.stringify(inFrame)}`);
      await framed.close();
    }

    // ---- 5. programmatic injection recovers a tab with no content script ---
    const injected = await worker.evaluate(async (site) => {
      const [tab] = await chrome.tabs.query({ url: `${site}/*` });
      if (!tab) return { error: 'no-tab' };
      // Re-injecting must be a harmless no-op: this is the path that repairs a
      // tab which was already open when the extension loaded.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['src/content/loader.js'],
      });
      const pong = await chrome.tabs
        .sendMessage(tab.id, { type: 'bg:ping', payload: {} }, { frameId: 0 })
        .catch((e) => ({ error: e.message }));
      return { pong };
    }, `http://127.0.0.1:${SITE_PORT}`);
    check('re-injecting the content script is a safe no-op', injected?.pong?.data?.pong === true, JSON.stringify(injected));

    // A browser-internal page must produce our own reason, not Chrome's raw string.
    await options.bringToFront();
    await options.waitForTimeout(200);
    const guard = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:rescan-active-tab', payload: {} }));
    check('non-injectable tab reports a friendly reason', guard?.error === 'not-injectable', JSON.stringify(guard));

    // ---- 6. UI pages render cleanly ---------------------------------------
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
