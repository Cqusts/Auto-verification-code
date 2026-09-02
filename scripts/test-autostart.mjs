#!/usr/bin/env node
/**
 * Checks the autostart installer: what it generates for each OS, that a real
 * install/uninstall round-trip is clean, and that previewing another platform
 * never touches this machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'bridge', 'autostart.mjs');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

function run(args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'avc-autostart-'));
  return {
    dir,
    env: { XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_STATE_HOME: path.join(dir, 'state') },
    files() {
      const out = [];
      const walk = (d) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else out.push(path.relative(dir, full));
        }
      };
      walk(dir);
      return out.sort();
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// --- what each platform's files look like ----------------------------------
const linux = run(['install', '--platform', 'linux', '--port', '9001']);
check('linux emits a systemd user unit', linux.includes('[Install]') && linux.includes('WantedBy=default.target'));
check('linux unit runs the bridge quietly', /ExecStart=.*bridge\/server\.mjs --port 9001 .*--quiet/.test(linux), 'no matching ExecStart');
check('linux unit restarts on failure', linux.includes('Restart=on-failure'));

const darwin = run(['install', '--platform', 'darwin', '--port', '9002']);
check('macOS emits a LaunchAgent plist', darwin.includes('<key>Label</key>') && darwin.includes('com.auto-verification-code.bridge'));
check('macOS agent starts at login', darwin.includes('<key>RunAtLoad</key>'));
check('macOS agent logs to Library/Logs', /StandardOutPath[\s\S]{0,80}Library\/Logs/.test(darwin));
check('macOS plist passes the port', darwin.includes('<string>9002</string>'));

const win = run(['install', '--platform', 'win32', '--port', '9003']);
check('windows uses the Startup folder', win.includes('Startup') && win.includes('.vbs'));
check('windows launcher runs hidden', win.includes(', 0, False'), 'missing hidden window flag');
check('windows cmd redirects to a log', /bridge\.log[\s\S]{0,8}2>&1/.test(win) || win.includes('bridge.log" 2>&1'));
check('windows install needs no admin rights', win.includes('无需管理员权限'));

// Autostart must never write codes or the token into a log file.
for (const [name, out] of [['linux', linux], ['macOS', darwin], ['windows', win]]) {
  check(`${name} service runs with --quiet`, out.includes('--quiet'));
}

// --- previewing another platform must not touch this machine ---------------
{
  const box = sandbox();
  const other = process.platform === 'win32' ? 'linux' : 'win32';
  run(['install', '--platform', other], box.env);
  check('--platform never writes to disk', box.files().length === 0, box.files().join(', '));
  box.cleanup();
}

// --- real round-trip on this platform --------------------------------------
{
  const box = sandbox();
  run(['install', '--port', '9004'], box.env);
  const afterInstall = box.files();
  check('install writes a service definition', afterInstall.some((f) => /service|plist|vbs/.test(f)), afterInstall.join(', '));
  check('install persists the token', afterInstall.some((f) => f.endsWith('token')), afterInstall.join(', '));

  const status = run(['status', '--port', '9004'], box.env);
  check('status reports the definition as installed', status.includes('已安装'));
  check('status notices the service is not running', status.includes('无响应'));

  run(['uninstall', '--port', '9004'], box.env);
  const afterUninstall = box.files();
  check('uninstall removes the service definition', !afterUninstall.some((f) => /service|plist|vbs/.test(f)), afterUninstall.join(', '));
  check('uninstall keeps the token for next time', afterUninstall.some((f) => f.endsWith('token')), afterUninstall.join(', '));

  const status2 = run(['status', '--port', '9004'], box.env);
  check('status reports it as uninstalled afterwards', status2.includes('未安装'));
  box.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
