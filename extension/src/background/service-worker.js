import { MSG, LIMITS, SOURCE, OCR_PROVIDER, CODE_TTL_MS } from '../common/constants.js';
import { getSettings, onSettingsChanged, updateSettings } from '../common/settings.js';
import { registerHandlers, sendToTab } from '../common/messaging.js';
import { log, setDebug, getLogs, clearLogs, hydrateLogs } from '../common/logger.js';
import { extractCode, looksLikeVerificationSms } from '../common/code-extract.js';
import { isSiteAllowed, isInjectableUrl } from '../common/site-rules.js';
import { hostnameOf, maskCode, RateLimiter } from '../common/util.js';
import { codeStore, fieldRegistry } from './state.js';
import { ensureOffscreen, closeOffscreen, callOffscreen, hasOffscreen } from './offscreen.js';
import { captureVisibleTab, fetchImageAsDataUrl } from './image.js';
import { injectInto, injectIntoOpenTabs, isNoReceiverError } from './inject.js';

const ALARM_TICK = 'avc-tick';

/** Guards against a page looping the OCR path; the cost is CPU and site load. */
const ocrLimiter = new RateLimiter(LIMITS.MAX_OCR_PER_MINUTE, 60_000);

let bridgeStatus = { ws: 'off', http: 'off', lastMessageAt: 0, lastError: '' };
let keepAlivePort = null;

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

async function boot() {
  const settings = await getSettings({ fresh: true });
  setDebug(settings.advanced.debug);
  await hydrateLogs();
  await syncOffscreen(settings);
  await refreshBadge();
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
  log.info('bg', 'service worker ready');
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await boot();
  // Tabs opened before this install/update have no content script yet.
  await injectIntoOpenTabs();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage?.();
  }
});
chrome.runtime.onStartup.addListener(async () => {
  await boot();
  await injectIntoOpenTabs();
});
boot().catch((err) => log.error('bg', 'boot failed', err));

onSettingsChanged(async (settings) => {
  setDebug(settings.advanced.debug);
  await syncOffscreen(settings);
  await refreshBadge();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_TICK) return;
  const settings = await getSettings();
  await syncOffscreen(settings);
  await refreshBadge();
});

/** The offscreen document owns the bridge sockets and the OCR worker. */
async function syncOffscreen(settings) {
  const needsBridge =
    settings.enabled && (settings.sources.ws.enabled || settings.sources.http.enabled);
  if (needsBridge) {
    await ensureOffscreen();
    await callOffscreen(MSG.BRIDGE_CONFIGURE, {
      ws: settings.sources.ws,
      http: settings.sources.http,
      keepAlive: settings.advanced.keepAlive,
    });
  } else if (await hasOffscreen()) {
    await callOffscreen(MSG.BRIDGE_CONFIGURE, { ws: { enabled: false }, http: { enabled: false } });
    // Keep the document around only if it is still useful for OCR warm starts.
    if (settings.captcha.provider !== OCR_PROVIDER.LOCAL) await closeOffscreen();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'avc-keepalive') return;
  keepAlivePort = port;
  port.onDisconnect.addListener(() => {
    keepAlivePort = null;
  });
  port.onMessage.addListener(() => {
    // Traffic on the port is what actually resets the worker idle timer.
  });
});

// ---------------------------------------------------------------------------
// badge
// ---------------------------------------------------------------------------

async function refreshBadge() {
  const settings = await getSettings();
  let text = '';
  let color = '#2f855a';
  if (!settings.enabled) {
    text = 'off';
    color = '#718096';
  } else {
    const pending = await codeStore.latest({ maxAgeMs: CODE_TTL_MS, unconsumedOnly: true });
    const bridgeWanted = settings.sources.ws.enabled || settings.sources.http.enabled;
    if (pending) {
      text = '1';
      color = '#2f855a';
    } else if (bridgeWanted && bridgeStatus.ws === 'error') {
      text = '!';
      color = '#c05621';
    }
  }
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
}

// ---------------------------------------------------------------------------
// incoming codes
// ---------------------------------------------------------------------------

/**
 * Turns a raw bridge payload into a stored code and pushes it at the page.
 * @returns {{stored:boolean, delivered:boolean, reason?:string}}
 */
async function ingestText(text, source, { kind = 'sms', force = false } = {}) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.otp.enabled) return { stored: false, delivered: false, reason: 'disabled' };

  if (!force && !looksLikeVerificationSms(text, settings.otp.keywords)) {
    log.debug('bg', 'message ignored: no verification keyword');
    return { stored: false, delivered: false, reason: 'not-a-code-sms' };
  }

  const code = extractCode(text, {
    minLength: settings.otp.minLength,
    maxLength: settings.otp.maxLength,
    charset: settings.otp.charset,
    keywords: settings.otp.keywords,
  });
  if (!code) {
    log.debug('bg', 'no code found in message');
    return { stored: false, delivered: false, reason: 'no-code' };
  }

  const entry = await codeStore.add({
    code,
    source,
    text,
    kind,
    historySize: settings.advanced.historySize,
  });
  if (!entry) return { stored: false, delivered: false, reason: 'duplicate' };

  log.info('bg', `code received from ${source}`, { code: maskCode(code) });
  bridgeStatus.lastMessageAt = Date.now();
  await notify(code);
  const delivered = await deliverCode(entry);
  await refreshBadge();
  return { stored: true, delivered };
}

async function notify(code) {
  const settings = await getSettings();
  if (!settings.ui.notifyOnCode || !chrome.notifications) return;
  const granted = await chrome.permissions.contains({ permissions: ['notifications'] }).catch(() => false);
  if (!granted) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon-128.png'),
    title: '收到验证码 / Code received',
    message: `${maskCode(code)} — 已尝试自动填写`,
  });
}

/** Pushes a code to the best candidate frame. Returns true once a frame filled it. */
async function deliverCode(entry) {
  const settings = await getSettings();
  if (!settings.otp.autoFill) return false;

  const targets = await fieldRegistry.list();
  if (!targets.length) {
    log.debug('bg', 'no frame is showing an OTP field');
    return false;
  }

  let activeTabId = null;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabId = active?.id ?? null;
  } catch {
    /* no window focused */
  }

  // Active tab first, then most-recently-seen fields.
  const ordered = [...targets].sort((a, b) => {
    const aActive = a.tabId === activeTabId ? 1 : 0;
    const bActive = b.tabId === activeTabId ? 1 : 0;
    return bActive - aActive || b.at - a.at;
  });

  for (const target of ordered) {
    if (!isSiteAllowed(target.host, settings)) continue;
    const res = await sendToTab(
      target.tabId,
      MSG.DELIVER_CODE,
      { code: entry.code, codeId: entry.id, source: entry.source, receivedAt: entry.receivedAt },
      { frameId: target.frameId },
    );
    if (res?.ok && res.data?.filled) {
      await codeStore.markConsumed(entry.id, { tabId: target.tabId, host: target.host });
      log.info('bg', `code filled on ${target.host}`);
      return true;
    }
    if (!res?.ok) await fieldRegistry.remove(target.tabId, target.frameId);
  }
  return false;
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

async function runOcr(payload, sender) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.captcha.enabled) throw new Error('captcha-disabled');
  if (settings.captcha.provider === OCR_PROVIDER.OFF) throw new Error('ocr-off');

  const host = hostnameOf(sender?.url || sender?.tab?.url || '');
  if (host && !isSiteAllowed(host, settings)) throw new Error('site-not-allowed');
  if (!ocrLimiter.allow(host || 'global')) throw new Error('rate-limited');

  let dataUrl = payload.dataUrl || null;
  let crop = null;

  // The content script could not read the pixels (tainted canvas): screenshot instead.
  if (!dataUrl && payload.rect && sender?.tab?.id != null) {
    const shot = await captureVisibleTab(sender.tab.windowId);
    if (shot) {
      dataUrl = shot;
      crop = { ...payload.rect, dpr: payload.devicePixelRatio || 1 };
    }
  }
  // Absolute last resort — may re-roll a single-use CAPTCHA.
  if (!dataUrl && payload.imageUrl) {
    dataUrl = await fetchImageAsDataUrl(payload.imageUrl);
  }
  if (!dataUrl) throw new Error('no-image');

  const res = await callOffscreen(
    MSG.OCR_RUN,
    { dataUrl, crop, captcha: settings.captcha },
    { timeoutMs: 45_000 },
  );
  if (!res?.ok) throw new Error(res?.error || 'ocr-failed');
  log.info('bg', `ocr "${res.data?.text || ''}" (${Math.round(res.data?.confidence || 0)}%) on ${host}`);
  return res.data;
}

// ---------------------------------------------------------------------------
// message routing
// ---------------------------------------------------------------------------

registerHandlers({
  [MSG.CONTENT_READY]: async (payload, sender) => {
    const settings = await getSettings();
    const host = hostnameOf(sender?.url || payload.url || '');
    return {
      allowed: isSiteAllowed(host, settings),
      settings: publicSettings(settings),
    };
  },

  [MSG.OTP_FIELD_FOUND]: async (payload, sender) => {
    if (sender?.tab?.id == null) return { code: null };
    const settings = await getSettings();
    const host = hostnameOf(sender.url || sender.tab.url || '');
    if (!isSiteAllowed(host, settings)) return { code: null };

    await fieldRegistry.set(sender.tab.id, sender.frameId ?? 0, { host, kind: payload.kind || 'otp' });

    // A code may already be waiting (the SMS beat the page).
    if (!settings.otp.autoFill) return { code: null };
    const entry = await codeStore.latest({ maxAgeMs: settings.otp.ttlSeconds * 1000 });
    if (!entry) return { code: null };
    if (settings.otp.requireFreshCode && payload.pageOpenedAt && entry.receivedAt < payload.pageOpenedAt) {
      return { code: null };
    }
    return { code: entry.code, codeId: entry.id, source: entry.source, receivedAt: entry.receivedAt };
  },

  [MSG.OTP_FIELD_LOST]: async (_payload, sender) => {
    if (sender?.tab?.id != null) await fieldRegistry.remove(sender.tab.id, sender.frameId ?? 0);
    return { ok: true };
  },

  [MSG.REQUEST_LATEST_CODE]: async (_payload, sender) => {
    const settings = await getSettings();
    // A request from the popup/options page carries no tab; those are our own UI.
    if (sender?.tab) {
      const host = hostnameOf(sender.url || '');
      if (!isSiteAllowed(host, settings)) return { code: null };
    } else if (!settings.enabled) {
      return { code: null };
    }
    const entry = await codeStore.latest({ maxAgeMs: settings.otp.ttlSeconds * 1000, unconsumedOnly: false });
    return entry ? { code: entry.code, codeId: entry.id, receivedAt: entry.receivedAt } : { code: null };
  },

  [MSG.REQUEST_OCR]: (payload, sender) => runOcr(payload, sender),

  [MSG.REPORT_FILL]: async (payload, sender) => {
    if (payload.codeId && payload.ok) {
      await codeStore.markConsumed(payload.codeId, {
        tabId: sender?.tab?.id ?? null,
        host: hostnameOf(sender?.url || ''),
      });
      await refreshBadge();
    }
    return { ok: true };
  },

  // --- offscreen -> background -------------------------------------------
  [MSG.OFFSCREEN_READY]: async () => {
    const settings = await getSettings();
    await callOffscreen(MSG.BRIDGE_CONFIGURE, {
      ws: settings.sources.ws,
      http: settings.sources.http,
      keepAlive: settings.advanced.keepAlive,
    });
    return { ok: true };
  },

  [MSG.BRIDGE_MESSAGE]: async (payload) => ingestText(payload.text || '', payload.source || SOURCE.BRIDGE_WS),

  [MSG.BRIDGE_STATUS]: async (payload) => {
    bridgeStatus = { ...bridgeStatus, ...payload };
    await refreshBadge();
    return { ok: true };
  },

  // --- popup / options ----------------------------------------------------
  [MSG.GET_STATE]: async () => {
    const settings = await getSettings();
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const host = hostnameOf(active?.url || '');
    const fields = active?.id != null ? (await fieldRegistry.list()).filter((f) => f.tabId === active.id) : [];
    // Ask the page what it can see, injecting first if this tab predates the extension.
    let page = null;
    if (active?.id != null && isInjectableUrl(active.url)) {
      const ping = await sendToTabOrInject(active.id, MSG.PING, {}, { frameId: 0 });
      page = ping.ok ? { ...ping.data, injected: true } : { injected: false, error: ping.error };
    }
    return {
      settings,
      bridgeStatus,
      offscreen: await hasOffscreen(),
      codes: await codeStore.list(),
      activeTab: active
        ? {
            id: active.id,
            host,
            injectable: isInjectableUrl(active.url),
            allowed: isSiteAllowed(host, settings),
            // Fields living in sub-frames are known here even when the top frame has none.
            registeredFields: fields.length,
            page,
            fieldOverride: (settings.sites.fieldOverrides || {})[host]?.otp || '',
          }
        : null,
    };
  },

  [MSG.SUBMIT_MANUAL_CODE]: async (payload) => {
    const raw = String(payload.text || '').trim();
    if (!raw) throw new Error('empty');
    return ingestText(raw, SOURCE.MANUAL, { force: true });
  },

  [MSG.RESCAN_ACTIVE_TAB]: async () => {
    const active = await activeTabOrThrow();
    const res = await sendToTabOrInject(active.id, MSG.TRIGGER_SCAN, {});
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },

  [MSG.SOLVE_ACTIVE_TAB]: async () => {
    const active = await activeTabOrThrow();
    const res = await sendToTabOrInject(active.id, MSG.TRIGGER_CAPTCHA, { manual: true });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },

  [MSG.FILL_ACTIVE_TAB]: async () => {
    const active = await activeTabOrThrow();
    const settings = await getSettings();
    const entry = await codeStore.latest({
      maxAgeMs: settings.otp.ttlSeconds * 1000,
      unconsumedOnly: false,
    });
    if (!entry) throw new Error('no-code');
    const res = await sendToTabOrInject(active.id, MSG.FILL_TEXT, {
      code: entry.code,
      codeId: entry.id,
      source: entry.source,
    });
    if (!res.ok) throw new Error(res.error);
    if (res.data?.filled) await codeStore.markConsumed(entry.id, { tabId: active.id });
    await refreshBadge();
    return res.data;
  },

  [MSG.PICK_ACTIVE_TAB]: async () => {
    const active = await activeTabOrThrow();
    // No frameId: the login form is often inside an iframe, so every frame
    // enters pick mode and whichever one the user clicks in reports back.
    const res = await sendToTabOrInject(active.id, MSG.PICK_START, {});
    if (!res.ok) throw new Error(res.error);
    return { started: true };
  },

  [MSG.PICK_RESULT]: async (payload, sender) => {
    if (!payload.selector || !payload.host) return { ok: false };
    const settings = await getSettings({ fresh: true });
    const overrides = { ...(settings.sites.fieldOverrides || {}) };
    // Saved per host so one site's quirk never affects another.
    overrides[payload.host] = { ...(overrides[payload.host] || {}), otp: payload.selector };
    await updateSettings({ sites: { fieldOverrides: overrides } });
    log.info('bg', `manual field override for ${payload.host}: ${payload.selector}`);
    // Take the other frames out of pick mode.
    if (sender?.tab?.id != null) sendToTab(sender.tab.id, MSG.PICK_CANCEL, {}).catch(() => {});

    // The code may already be waiting; deliver it now instead of after the next SMS.
    const entry = await codeStore.latest({ maxAgeMs: settings.otp.ttlSeconds * 1000 });
    if (entry && settings.otp.autoFill) await deliverCode(entry);
    return { ok: true };
  },

  [MSG.CLEAR_FIELD_OVERRIDE]: async (payload) => {
    const settings = await getSettings({ fresh: true });
    const overrides = { ...(settings.sites.fieldOverrides || {}) };
    delete overrides[payload.host];
    await updateSettings({ sites: { fieldOverrides: overrides } });
    return { ok: true };
  },

  [MSG.CLIPBOARD_ACTIVE_TAB]: async () => {
    const active = await activeTabOrThrow();
    const res = await sendToTabOrInject(active.id, MSG.READ_CLIPBOARD, {});
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },

  [MSG.TEST_BRIDGE]: async (payload) => {
    await ensureOffscreen();
    return callOffscreen(MSG.BRIDGE_TEST, payload, { timeoutMs: 15_000 });
  },

  [MSG.TEST_OCR]: async (payload) => {
    const settings = await getSettings();
    await ensureOffscreen();
    const res = await callOffscreen(
      MSG.OCR_RUN,
      { dataUrl: payload.dataUrl, captcha: { ...settings.captcha, ...(payload.overrides || {}) } },
      { timeoutMs: 60_000 },
    );
    if (!res?.ok) throw new Error(res?.error || 'ocr-failed');
    return res.data;
  },

  [MSG.CLEAR_HISTORY]: async () => {
    await codeStore.clear();
    await clearLogs();
    await refreshBadge();
    return { ok: true };
  },

  [MSG.GET_LOGS]: async () => ({ logs: getLogs() }),
});

/**
 * Messages a tab, injecting the content script and retrying once when the tab
 * turns out not to have one (extension installed or reloaded after the page).
 */
async function sendToTabOrInject(tabId, type, payload = {}, options = {}) {
  const first = await sendToTab(tabId, type, payload, options);
  if (first.ok || !isNoReceiverError(first.error)) return first;
  if (!(await injectInto(tabId))) return { ok: false, error: 'not-injectable' };
  return sendToTab(tabId, type, payload, options);
}

/** Resolves the active tab, or throws a reason the UI can show verbatim. */
async function activeTabOrThrow() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) throw new Error('no-active-tab');
  if (!isInjectableUrl(active.url)) throw new Error('not-injectable');
  return active;
}

/** The slice of settings a content script is allowed to see. */
function publicSettings(settings) {
  return {
    enabled: settings.enabled,
    otp: {
      enabled: settings.otp.enabled,
      autoFill: settings.otp.autoFill,
      autoSubmit: settings.otp.autoSubmit,
      minLength: settings.otp.minLength,
      maxLength: settings.otp.maxLength,
      charset: settings.otp.charset,
      skipNonEmpty: settings.otp.skipNonEmpty,
      highlight: settings.otp.highlight,
      ttlSeconds: settings.otp.ttlSeconds,
    },
    captcha: {
      enabled: settings.captcha.enabled,
      provider: settings.captcha.provider,
      autoFill: settings.captcha.autoFill,
      charset: settings.captcha.charset,
      autoSubmit: settings.captcha.autoSubmit,
      expectedLength: settings.captcha.expectedLength,
      minConfidence: settings.captcha.minConfidence,
      maxRetries: settings.captcha.maxRetries,
      solveOnDetect: settings.captcha.solveOnDetect,
      solveOnImageChange: settings.captcha.solveOnImageChange,
    },
    sources: { clipboard: settings.sources.clipboard },
    sites: { fieldOverrides: settings.sites.fieldOverrides || {} },
    ui: settings.ui,
    advanced: { debug: settings.advanced.debug },
  };
}

// ---------------------------------------------------------------------------
// tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  fieldRegistry.remove(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') fieldRegistry.remove(tabId).catch(() => {});
});

