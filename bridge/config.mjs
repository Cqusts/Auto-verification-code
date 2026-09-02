/**
 * Where the bridge keeps its state, and how the auth token is resolved.
 *
 * The token has to survive restarts: once the service is set to start with the
 * machine, a token regenerated on every boot would silently break the extension's
 * saved configuration. So it is generated once and persisted with 0600.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const APP = 'auto-verification-code';

/**
 * Per-platform config/log locations, following each OS's convention.
 * `platform` is overridable so `autostart --platform win32` can preview the real
 * Windows paths from any machine.
 */
export function paths(platform = process.platform) {
  const home = os.homedir();
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return {
      config: join(appData, APP),
      data: join(localAppData, APP),
      log: join(localAppData, APP, 'bridge.log'),
    };
  }
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support', APP);
    return { config: support, data: support, log: join(home, 'Library', 'Logs', `${APP}-bridge.log`) };
  }
  const config = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), APP);
  const data = join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), APP);
  return { config, data, log: join(data, 'bridge.log') };
}

export function tokenFile(platform = process.platform) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(paths(platform).config, 'token');
}

export function readToken() {
  const file = tokenFile();
  if (!existsSync(file)) return null;
  const value = readFileSync(file, 'utf8').trim();
  return value || null;
}

export function writeToken(token) {
  const file = tokenFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, 'utf8');
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no POSIX mode; the per-user profile directory already limits access.
  }
  return file;
}

/**
 * Explicit flag > environment > persisted file > freshly generated (and saved).
 * @returns {{token:string, source:'flag'|'env'|'file'|'generated', file:string}}
 */
export function resolveToken(explicit) {
  const file = tokenFile();
  if (explicit) return { token: explicit, source: 'flag', file };
  if (process.env.AVC_TOKEN) return { token: process.env.AVC_TOKEN, source: 'env', file };
  const saved = readToken();
  if (saved) return { token: saved, source: 'file', file };
  const token = crypto.randomBytes(9).toString('base64url');
  writeToken(token);
  return { token, source: 'generated', file };
}
