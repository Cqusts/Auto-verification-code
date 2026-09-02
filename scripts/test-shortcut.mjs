#!/usr/bin/env node
/** The desktop shortcut is how most people will start the bridge, so check it. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'make-shortcut.mjs');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

const run = (args, env = {}) =>
  execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// --- previews ---------------------------------------------------------------
const win = run(['--platform', 'win32']);
check('windows shortcut is a .lnk on the desktop', win.includes('.lnk') && win.includes('Desktop'));
check('windows shortcut points at start-bridge.cmd', win.includes('start-bridge.cmd'));
check('windows shortcut uses the .ico', win.includes('icon.ico'));

const mac = run(['--platform', 'darwin']);
check('macOS shortcut is a double-clickable .command', mac.includes('.command'));
check('macOS shortcut execs start-bridge.sh', mac.includes('start-bridge.sh'));

const lin = run(['--platform', 'linux']);
check('linux shortcut is a .desktop entry', lin.includes('.desktop') && lin.includes('[Desktop Entry]'));
check('linux entry opens a terminal', lin.includes('Terminal=true'));
check('linux entry carries an icon', lin.includes('Icon='));

// --- the PowerShell that authors the .lnk ------------------------------------
// Windows PowerShell 5.1 decodes a .ps1 with the system ANSI code page unless
// the file has a BOM, so any Chinese in the script body arrives as mojibake on
// a zh-CN machine and breaks the parse. Keep the script pure ASCII and pass the
// Unicode through the environment, which Windows stores as UTF-16.
{
  const { windowsPowerShell } = await import('./make-shortcut.mjs');
  const { script, env } = windowsPowerShell({
    target: 'C:\\Users\\Administrator\\Desktop\\自动验证码 · 短信桥接.lnk',
    launcher: 'D:\\proj\\start-bridge.cmd',
    icon: 'D:\\proj\\icon.ico',
    root: 'D:\\proj',
  });

  const nonAscii = [...script].filter((c) => c.charCodeAt(0) > 127);
  check('the PowerShell body is pure ASCII', nonAscii.length === 0, JSON.stringify(nonAscii.join('')));
  check('every string comes from the environment', !/CreateShortcut\("/.test(script), script);
  check('it still sets target, icon and description',
    ['TargetPath', 'IconLocation', 'Description', 'WorkingDirectory', 'Save()'].every((k) => script.includes(k)));
  check('the environment carries the unicode path', env.AVC_LNK.includes('自动验证码'));
  check('the environment carries the description', /[^\x00-\x7F]/.test(env.AVC_DESC));
}

// Importing the module must not run the CLI: the tests above depend on that,
// and so would anything else that reuses windowsPowerShell().
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'avc-home-'));
  mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'pipe' },
  );
  check('importing the module creates nothing', readdirSync(path.join(home, 'Desktop')).length === 0);
  rmSync(home, { recursive: true, force: true });
}

// --- the icon the Windows shortcut needs -------------------------------------
{
  const ico = path.join(ROOT, 'extension', 'assets', 'icons', 'icon.ico');
  check('icon.ico exists', existsSync(ico));
  if (existsSync(ico)) {
    const head = readFileSync(ico).subarray(0, 6);
    // ICONDIR: reserved 0, type 1 (icon), then the image count.
    check('icon.ico has a valid header', head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0);
    check('icon.ico holds several sizes', head.readUInt16LE(4) >= 2, `count=${head.readUInt16LE(4)}`);
  }
}

// --- previewing another platform must not touch this machine -----------------
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'avc-home-'));
  mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  const other = process.platform === 'win32' ? 'linux' : 'win32';
  run(['--platform', other], { HOME: home, USERPROFILE: home });
  check('--platform never writes to disk', readdirSync(path.join(home, 'Desktop')).length === 0);
  rmSync(home, { recursive: true, force: true });
}

// --- real create / remove round trip ----------------------------------------
if (process.platform === 'win32') {
  console.log('  skip  create/remove round trip (needs a Windows desktop session)');
} else {
  const home = mkdtempSync(path.join(os.tmpdir(), 'avc-home-'));
  const desktop = path.join(home, 'Desktop');
  mkdirSync(desktop, { recursive: true });

  run([], { HOME: home });
  const [created] = readdirSync(desktop);
  check('creates exactly one desktop entry', readdirSync(desktop).length === 1, readdirSync(desktop).join(', '));
  check('the entry is executable', created ? (statSync(path.join(desktop, created)).mode & 0o111) !== 0 : false);

  const body = created ? readFileSync(path.join(desktop, created), 'utf8') : '';
  check('the entry points at this checkout', body.includes(ROOT), body.slice(0, 120));

  run(['--remove'], { HOME: home });
  check('remove deletes it', readdirSync(desktop).length === 0, readdirSync(desktop).join(', '));

  const again = run(['--remove'], { HOME: home });
  check('removing twice is not an error', again.includes('无需删除'));
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
