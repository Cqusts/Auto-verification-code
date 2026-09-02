/** Small dependency-free helpers shared by every context. */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));

export const uid = () => Math.random().toString(36).slice(2, 10);

export function debounce(fn, wait) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function throttle(fn, wait) {
  let last = 0;
  let timer;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  };
}

export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Reads `a.b.0.c` out of a nested object; returns undefined on any miss. */
export function getPath(obj, path) {
  if (!path) return obj;
  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Turns a user-written host pattern into a matcher.
 * Supports `example.com` (also matches subdomains), `*.example.com`, `*` and
 * `/regex/` when the user needs full control.
 */
export function hostMatcher(pattern) {
  const raw = String(pattern || '').trim().toLowerCase();
  if (!raw) return () => false;
  if (raw === '*') return () => true;
  if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const end = raw.lastIndexOf('/');
    try {
      const re = new RegExp(raw.slice(1, end), raw.slice(end + 1) || undefined);
      return (host) => re.test(host);
    } catch {
      return () => false;
    }
  }
  if (raw.startsWith('*.')) {
    const base = raw.slice(2);
    return (host) => host === base || host.endsWith(`.${base}`);
  }
  return (host) => host === raw || host.endsWith(`.${raw}`);
}

export function matchesAnyHost(host, patterns) {
  if (!host || !Array.isArray(patterns)) return false;
  return patterns.some((p) => hostMatcher(p)(host));
}

/** Never print a full code into logs or the badge. */
export function maskCode(code) {
  const s = String(code ?? '');
  if (s.length <= 2) return '*'.repeat(s.length);
  if (s.length <= 4) return `${s[0]}${'*'.repeat(s.length - 2)}${s[s.length - 1]}`;
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 3)}${s.slice(-1)}`;
}

/** Fixed-window rate limiter usable from any context. */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  allow(key = 'default') {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  reset(key) {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}
