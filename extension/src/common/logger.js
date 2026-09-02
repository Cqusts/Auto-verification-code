import { STORAGE, LIMITS } from './constants.js';

/**
 * Ring-buffer logger.
 *
 * The buffer is mirrored into `chrome.storage.session` (memory-only) so the
 * options page can still show recent activity after the service worker has been
 * suspended and restarted — which happens constantly under MV3.
 */
const memory = [];
let debugEnabled = false;
let hydrated = false;
let persistTimer = null;

export function setDebug(on) {
  debugEnabled = Boolean(on);
}

function safeDetail(detail) {
  if (detail instanceof Error) return { name: detail.name, message: detail.message };
  try {
    return JSON.parse(JSON.stringify(detail));
  } catch {
    return String(detail);
  }
}

/** Batched: a burst of debug lines must not turn into a burst of storage writes. */
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage?.session?.set({ [STORAGE.LOGS]: memory }).catch(() => {});
  }, 500);
}

function push(level, scope, message, detail) {
  const entry = {
    t: Date.now(),
    level,
    scope,
    message: String(message),
    detail: detail === undefined ? undefined : safeDetail(detail),
  };
  memory.push(entry);
  if (memory.length > LIMITS.MAX_LOGS) memory.splice(0, memory.length - LIMITS.MAX_LOGS);
  if (debugEnabled || level === 'error') {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[AVC:${scope}] ${message}`, detail ?? '');
  }
  schedulePersist();
  return entry;
}

export const log = {
  debug: (scope, message, detail) => (debugEnabled ? push('debug', scope, message, detail) : null),
  info: (scope, message, detail) => push('info', scope, message, detail),
  warn: (scope, message, detail) => push('warn', scope, message, detail),
  error: (scope, message, detail) => push('error', scope, message, detail),
};

/** Pulls back whatever a previous worker generation wrote. */
export async function hydrateLogs() {
  if (hydrated) return;
  hydrated = true;
  const got = await chrome.storage.session.get(STORAGE.LOGS).catch(() => null);
  const saved = got?.[STORAGE.LOGS];
  if (Array.isArray(saved) && saved.length) {
    memory.unshift(...saved.slice(-LIMITS.MAX_LOGS));
    if (memory.length > LIMITS.MAX_LOGS) memory.splice(0, memory.length - LIMITS.MAX_LOGS);
  }
}

export function getLogs() {
  return [...memory];
}

export async function clearLogs() {
  memory.length = 0;
  clearTimeout(persistTimer);
  persistTimer = null;
  await chrome.storage.session.remove(STORAGE.LOGS);
}
