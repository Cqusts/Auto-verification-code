import { STORAGE, CODE_TTL_MS, LIMITS } from '../common/constants.js';
import { maskCode, uid } from '../common/util.js';

/**
 * Verification codes live in `chrome.storage.session`: memory-backed, cleared when
 * the browser closes, and never written to disk.
 */
class CodeStore {
  constructor() {
    this.entries = [];
    this.hydrated = false;
  }

  async hydrate() {
    if (this.hydrated) return;
    const got = await chrome.storage.session.get(STORAGE.CODES);
    this.entries = Array.isArray(got?.[STORAGE.CODES]) ? got[STORAGE.CODES] : [];
    this.hydrated = true;
  }

  async persist() {
    await chrome.storage.session.set({ [STORAGE.CODES]: this.entries });
  }

  /** @returns {object|null} the stored entry, or null when it was a duplicate. */
  async add({ code, source, text = '', kind = 'sms', historySize = LIMITS.MAX_CODE_HISTORY }) {
    await this.hydrate();
    const now = Date.now();
    const duplicate = this.entries.find(
      (e) => e.code === code && e.source === source && now - e.receivedAt < 60_000,
    );
    if (duplicate) return null;

    const entry = {
      id: uid(),
      code,
      masked: maskCode(code),
      source,
      kind,
      // Only a short excerpt is kept, purely so the user can tell which SMS it came from.
      excerpt: String(text).slice(0, 120),
      receivedAt: now,
      consumed: false,
      consumedBy: null,
    };
    this.entries.unshift(entry);
    const cap = Math.min(Math.max(1, historySize), LIMITS.MAX_CODE_HISTORY);
    if (this.entries.length > cap) this.entries.length = cap;
    await this.persist();
    return entry;
  }

  async latest({ maxAgeMs = CODE_TTL_MS, unconsumedOnly = true } = {}) {
    await this.hydrate();
    const now = Date.now();
    return (
      this.entries.find(
        (e) => now - e.receivedAt <= maxAgeMs && (!unconsumedOnly || !e.consumed),
      ) || null
    );
  }

  async markConsumed(id, by) {
    await this.hydrate();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.consumed = true;
    entry.consumedBy = by || null;
    entry.consumedAt = Date.now();
    await this.persist();
    return entry;
  }

  async list() {
    await this.hydrate();
    // Never hand raw codes to UI listings; the popup asks for one explicitly.
    return this.entries.map(({ code, ...rest }) => rest);
  }

  async clear() {
    this.entries = [];
    this.hydrated = true;
    await chrome.storage.session.remove(STORAGE.CODES);
  }
}

/**
 * Which frames currently show a fillable field. Mirrored into session storage so a
 * restarted service worker still knows where to deliver a code.
 */
class FieldRegistry {
  constructor() {
    this.map = new Map();
    this.hydrated = false;
  }

  key(tabId, frameId) {
    return `${tabId}:${frameId}`;
  }

  async hydrate() {
    if (this.hydrated) return;
    const got = await chrome.storage.session.get(STORAGE.STATUS);
    const saved = got?.[STORAGE.STATUS]?.fields;
    if (Array.isArray(saved)) this.map = new Map(saved);
    this.hydrated = true;
  }

  async persist() {
    await chrome.storage.session.set({
      [STORAGE.STATUS]: { fields: [...this.map.entries()].slice(-50) },
    });
  }

  async set(tabId, frameId, info) {
    await this.hydrate();
    this.map.set(this.key(tabId, frameId), { tabId, frameId, ...info, at: Date.now() });
    await this.persist();
  }

  async remove(tabId, frameId) {
    await this.hydrate();
    if (frameId === undefined) {
      for (const k of [...this.map.keys()]) if (k.startsWith(`${tabId}:`)) this.map.delete(k);
    } else {
      this.map.delete(this.key(tabId, frameId));
    }
    await this.persist();
  }

  /** Most recently seen first, stale entries dropped. */
  async list({ maxAgeMs = 10 * 60 * 1000 } = {}) {
    await this.hydrate();
    const now = Date.now();
    const alive = [...this.map.values()].filter((v) => now - v.at <= maxAgeMs);
    alive.sort((a, b) => b.at - a.at);
    return alive;
  }
}

export const codeStore = new CodeStore();
export const fieldRegistry = new FieldRegistry();
