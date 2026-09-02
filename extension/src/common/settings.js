import { DEFAULT_SETTINGS } from './defaults.js';
import { STORAGE } from './constants.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep-merges `override` onto `base` without mutating either. Arrays are replaced wholesale. */
export function mergeSettings(base, override) {
  if (!isPlainObject(override)) return structuredClone(base);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeSettings(out[key], value);
    else if (value !== undefined) out[key] = isPlainObject(value) || Array.isArray(value) ? structuredClone(value) : value;
  }
  return out;
}

let cache = null;

export async function getSettings({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  const stored = await chrome.storage.local.get(STORAGE.SETTINGS);
  cache = mergeSettings(DEFAULT_SETTINGS, stored?.[STORAGE.SETTINGS]);
  return cache;
}

/** Patch is deep-merged into the stored settings. Returns the new full object. */
export async function updateSettings(patch) {
  const current = await getSettings({ fresh: true });
  const next = mergeSettings(current, patch);
  cache = next;
  await chrome.storage.local.set({ [STORAGE.SETTINGS]: next });
  return next;
}

export async function replaceSettings(full) {
  const next = mergeSettings(DEFAULT_SETTINGS, full);
  cache = next;
  await chrome.storage.local.set({ [STORAGE.SETTINGS]: next });
  return next;
}

export async function resetSettings() {
  cache = structuredClone(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ [STORAGE.SETTINGS]: cache });
  return cache;
}

/** Fires `cb(newSettings)` in this context whenever any context writes settings. */
export function onSettingsChanged(cb) {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[STORAGE.SETTINGS]) return;
    cache = mergeSettings(DEFAULT_SETTINGS, changes[STORAGE.SETTINGS].newValue);
    cb(cache);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export { DEFAULT_SETTINGS };
