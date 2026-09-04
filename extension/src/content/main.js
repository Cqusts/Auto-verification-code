import { MSG, SOURCE } from '../common/constants.js';
import { sendToRuntime, registerHandlers } from '../common/messaging.js';
import { debounce, RateLimiter } from '../common/util.js';
import { extractCode } from '../common/code-extract.js';
import { scanPage } from './field-detect.js';
import { fillField, submitFor } from './fill.js';
import { Chip, flashField } from './overlay.js';
import { CaptchaSolver } from './captcha.js';
import { startPicking, cancelPicking } from './picker.js';

const chip = new Chip();

const state = {
  settings: null,
  allowed: false,
  otp: null,
  captchas: [],
  lastClipboard: '',
  /**
   * When this page was opened — not when the field was spotted.
   *
   * Freshness is meant to stop a code from a *previous* session being replayed
   * into a new form. Keying it to detection time punished slow detection
   * instead: a code that arrived while the page was still being scanned looked
   * stale and was refused.
   */
  openedAt: Date.now(),
};

/** Stops a refreshing CAPTCHA from turning into a solve loop. */
const autoSolveLimiter = new RateLimiter(8, 60_000);
const observedImages = new WeakMap();

const solver = new CaptchaSolver({ chip, getSettings: () => state.settings });

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------

function otpIsEmpty(target) {
  const values = target.group ? target.group.map((el) => el.value) : [target.input.value];
  return values.every((v) => !v || !v.trim());
}

async function fillOtp({ code, codeId, source }) {
  if (!state.otp?.input?.isConnected) return { filled: false, reason: 'no-field' };
  const settings = state.settings;
  if (settings.otp.skipNonEmpty && !otpIsEmpty(state.otp)) {
    chip.show({ anchor: state.otp.input, state: 'waiting', text: '字段已有内容，未覆盖', autoHideMs: 4000 });
    return { filled: false, reason: 'not-empty' };
  }

  chip.show({ anchor: state.otp.input, state: 'working', text: '填写验证码…' });
  const ok = await fillField(state.otp, code);
  if (ok) {
    if (settings.otp.highlight) flashField(state.otp.input);
    chip.show({
      anchor: state.otp.input,
      state: 'done',
      text: `已填入验证码 ${code}`,
      autoHideMs: 4000,
    });
    if (settings.otp.autoSubmit) submitFor(state.otp.input);
  } else {
    chip.show({ anchor: state.otp.input, state: 'error', text: '填写未生效，请手动输入', autoHideMs: 5000 });
  }
  sendToRuntime(MSG.REPORT_FILL, { codeId, ok, source });
  return { filled: ok };
}

async function announceOtpField() {
  const res = await sendToRuntime(MSG.OTP_FIELD_FOUND, {
    kind: 'otp',
    pageOpenedAt: state.openedAt,
  });
  if (res.ok && res.data?.code) {
    await fillOtp(res.data);
    return;
  }
  if (state.settings?.otp?.autoFill && state.settings?.ui?.showBadge) {
    chip.show({ anchor: state.otp.input, state: 'waiting', text: '等待短信验证码…', autoHideMs: 6000 });
  }
}

// ---------------------------------------------------------------------------
// CAPTCHA
// ---------------------------------------------------------------------------

function watchCaptchaImage(target) {
  const { image } = target;
  if (observedImages.has(image.el)) {
    observedImages.get(image.el).target = target;
    return;
  }

  const record = { target, lastSolveAt: 0, observer: null };
  const onChanged = () => {
    solver.forget(image);
    const settings = state.settings;
    if (!settings?.captcha?.enabled || !settings.captcha.solveOnImageChange) return;
    if (Date.now() - record.lastSolveAt < 1500) return;
    if (!autoSolveLimiter.allow('captcha')) return;
    record.lastSolveAt = Date.now();
    solver.solve(record.target).catch(() => {});
  };

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.type === 'attributes')) onChanged();
  });
  observer.observe(image.el, { attributes: true, attributeFilter: ['src', 'style', 'srcset'] });
  image.el.addEventListener('load', onChanged);
  record.observer = observer;
  observedImages.set(image.el, record);

  // Give the user a manual path even when auto-solving is off.
  image.el.addEventListener('dblclick', () => solver.solve(record.target, { manual: true }));
}

async function maybeAutoSolve(target) {
  const settings = state.settings;
  if (!settings?.captcha?.enabled || !settings.captcha.solveOnDetect) return;
  if (target.input.value?.trim()) return;
  if (solver.hasSolved(target.image)) return;
  if (!autoSolveLimiter.allow('captcha')) return;
  const record = observedImages.get(target.image.el);
  if (record) record.lastSolveAt = Date.now();
  await solver.solve(target).catch(() => {});
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

let scanning = false;

async function scan() {
  if (scanning || !state.allowed || !state.settings?.enabled) return;
  scanning = true;
  try {
    const host = location.hostname.toLowerCase();
    const otpOverride = state.settings?.sites?.fieldOverrides?.[host]?.otp || '';
    const { otp, captchas } = scanPage({ otpOverride });

    // --- OTP field bookkeeping
    const previous = state.otp?.input;
    if (otp?.input) {
      if (previous !== otp.input) {
        state.otp = otp;
        if (state.settings.otp.enabled) await announceOtpField();
      } else {
        state.otp = otp;
      }
    } else if (previous) {
      state.otp = null;
      sendToRuntime(MSG.OTP_FIELD_LOST, {});
    }

    // --- CAPTCHA fields
    state.captchas = captchas;
    for (const target of captchas) {
      watchCaptchaImage(target);
      await maybeAutoSolve(target);
    }
  } finally {
    scanning = false;
  }
}

const scheduleScan = debounce(() => {
  scan().catch(() => {});
}, 350);

function startObserving() {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
        scheduleScan();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('focusin', scheduleScan, { passive: true });
  addEventListener('pageshow', scheduleScan, { passive: true });
}

// ---------------------------------------------------------------------------
// clipboard source
// ---------------------------------------------------------------------------

async function tryClipboard({ manual = false } = {}) {
  const cfg = state.settings?.sources?.clipboard;
  if (!manual && !cfg?.enabled) return { ok: false, reason: 'disabled' };
  if (!manual && cfg.onlyWithOtpField && !state.otp) return { ok: false, reason: 'no-field' };
  if (document.visibilityState !== 'visible') return { ok: false, reason: 'hidden' };

  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    return { ok: false, reason: 'clipboard-blocked', error: String(err?.message || err) };
  }
  if (!text || text === state.lastClipboard) return { ok: false, reason: 'unchanged' };
  state.lastClipboard = text;

  const code = extractCode(text, {
    minLength: state.settings.otp.minLength,
    maxLength: state.settings.otp.maxLength,
    charset: state.settings.otp.charset,
    // A clipboard copy is usually the bare code with no surrounding sentence.
    minScore: 0,
  });
  if (!code) return { ok: false, reason: 'no-code' };
  const result = await fillOtp({ code, codeId: null, source: SOURCE.CLIPBOARD });
  return { ok: result.filled, code };
}

let clipboardTimer = null;

function syncClipboardWatcher() {
  clearInterval(clipboardTimer);
  clipboardTimer = null;
  const cfg = state.settings?.sources?.clipboard;
  if (!cfg?.enabled || window !== window.top) return;
  const seconds = Math.max(2, Number(cfg.intervalSeconds) || 2);
  clipboardTimer = setInterval(() => {
    tryClipboard().catch(() => {});
  }, seconds * 1000);
}

// ---------------------------------------------------------------------------
// messages from the background
// ---------------------------------------------------------------------------

registerHandlers({
  [MSG.DELIVER_CODE]: async (payload) => {
    if (!state.allowed || !state.settings?.otp?.enabled) return { filled: false, reason: 'disabled' };
    return fillOtp(payload);
  },

  [MSG.TRIGGER_SCAN]: async () => {
    await scan();
    return {
      otp: Boolean(state.otp),
      captchas: state.captchas.length,
    };
  },

  [MSG.TRIGGER_CAPTCHA]: async (payload) => {
    await scan();
    const target = state.captchas[0];
    if (!target) return { ok: false, reason: 'no-captcha' };
    return solver.solve(target, { manual: payload?.manual !== false });
  },

  [MSG.FILL_TEXT]: async (payload) => fillOtp({ code: payload.code, codeId: payload.codeId, source: 'manual' }),

  [MSG.READ_CLIPBOARD]: async () => tryClipboard({ manual: true }),

  [MSG.PICK_START]: async () => {
    startPicking(async ({ selector, label }) => {
      await sendToRuntime(MSG.PICK_RESULT, {
        selector,
        label,
        // Each frame reports its own host, so a field inside an iframe is
        // remembered against the iframe's origin — which is where the content
        // script that has to find it again will look.
        host: location.hostname.toLowerCase(),
      });
      await scan();
    });
    return { started: true };
  },

  [MSG.PICK_CANCEL]: async () => {
    cancelPicking();
    return { ok: true };
  },

  [MSG.PING]: async () => ({ pong: true, otp: Boolean(state.otp), captchas: state.captchas.length }),
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  const res = await sendToRuntime(MSG.CONTENT_READY, { url: location.href });
  if (!res.ok) return;
  state.allowed = Boolean(res.data?.allowed);
  state.settings = res.data?.settings || null;
  if (!state.allowed || !state.settings?.enabled) return;

  startObserving();
  syncClipboardWatcher();
  await scan();
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const res = await sendToRuntime(MSG.CONTENT_READY, { url: location.href });
  if (!res.ok) return;
  state.allowed = Boolean(res.data?.allowed);
  state.settings = res.data?.settings || null;
  syncClipboardWatcher();
  scheduleScan();
});

boot().catch((err) => console.error('[AVC] boot failed', err));
