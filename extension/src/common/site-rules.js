import { matchesAnyHost, hostnameOf } from './util.js';

/**
 * Decides whether the extension may act on a page.
 * blocklist always wins; in `allowlist` mode nothing runs unless listed.
 */
export function isSiteAllowed(hostOrUrl, settings) {
  const host = hostOrUrl?.includes('://') ? hostnameOf(hostOrUrl) : String(hostOrUrl || '').toLowerCase();
  if (!host) return false;
  if (!settings?.enabled) return false;
  const rules = settings.sites || {};
  if (matchesAnyHost(host, rules.blocklist || [])) return false;
  if (rules.mode === 'allowlist') return matchesAnyHost(host, rules.allowlist || []);
  return true;
}

/** Pages we can never usefully inject into. */
export function isInjectableUrl(url) {
  if (!url) return false;
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}
