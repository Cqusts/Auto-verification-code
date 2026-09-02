#!/usr/bin/env node
/**
 * Puts a launcher for the SMS bridge on the desktop, so it can be started with
 * one click from anywhere instead of navigating into the project folder.
 *
 *   node scripts/make-shortcut.mjs            # create it
 *   node scripts/make-shortcut.mjs --remove   # delete it
 *   node scripts/make-shortcut.mjs --platform win32   # preview, never touches this machine
 *
 * The shortcut stores an absolute path to the project, so it has to be
 * regenerated if the project folder is moved. Everything else keeps working
 * off the launcher script's own location.
 */
import { writeFileSync, rmSync, existsSync, mkdirSync, chmodSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '自动验证码 · 短信桥接';
const ASCII_NAME = 'auto-verification-code-bridge';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(`--${flag}`);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const platform = flagValue('platform', process.platform);
// --platform exists to preview another OS's output; it must never write here.
const dryRun = has('dry-run') || argv.includes('--platform');
const remove = has('remove') || has('uninstall');

/**
 * The Desktop is not always ~/Desktop: OneDrive redirection is common on
 * Windows, and localised names are common everywhere. Ask the OS when we can.
 */
function desktopDir() {
  if (platform === 'win32' && process.platform === 'win32' && !dryRun) {
    try {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("Desktop")'],
        { encoding: 'utf8' },
      ).trim();
      if (out) return out;
    } catch {
      // Fall through to the conventional location.
    }
  }
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(os.homedir(), 'Desktop');
}

function plan() {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const desktop = desktopDir();

  if (platform === 'win32') {
    return {
      kind: 'Windows 快捷方式',
      target: join(desktop, `${NAME}.lnk`),
      launcher: join(ROOT, 'start-bridge.cmd'),
      icon: join(ROOT, 'extension', 'assets', 'icons', 'icon.ico'),
    };
  }
  if (platform === 'darwin') {
    return {
      kind: 'macOS .command 文件',
      target: join(desktop, `${NAME}.command`),
      launcher: join(ROOT, 'start-bridge.sh'),
      content: `#!/bin/sh\n# Auto Verification Code — 短信桥接\n# 由 scripts/make-shortcut.mjs 生成；删除本文件即可移除。\nexec ${JSON.stringify(join(ROOT, 'start-bridge.sh'))}\n`,
      mode: 0o755,
    };
  }
  return {
    kind: 'Linux .desktop 项',
    target: join(desktop, `${ASCII_NAME}.desktop`),
    launcher: join(ROOT, 'start-bridge.sh'),
    content:
      `[Desktop Entry]\n` +
      `Type=Application\n` +
      `Name=${NAME}\n` +
      `Comment=启动短信验证码桥接服务\n` +
      `Exec=${join(ROOT, 'start-bridge.sh')}\n` +
      `Icon=${join(ROOT, 'extension', 'assets', 'icons', 'icon-128.png')}\n` +
      `Path=${ROOT}\n` +
      `Terminal=true\n` +
      `Categories=Utility;Network;\n`,
    mode: 0o755,
  };
}

const SHORTCUT_DESCRIPTION = '启动 Auto Verification Code 的短信桥接服务';

/**
 * Builds the PowerShell that authors the .lnk (WScript.Shell is the only
 * supported way to do it) plus the environment it reads.
 *
 * The script body is deliberately pure ASCII. Windows PowerShell 5.1 decodes a
 * .ps1 using the system ANSI code page unless the file carries a BOM, so on a
 * zh-CN machine any Chinese written into the script comes back as mojibake —
 * and the mangled bytes swallow the closing quote, failing with "The string is
 * missing the terminator". Passing every non-ASCII value through the
 * environment block sidesteps the file's encoding entirely: Windows stores it
 * as UTF-16 and hands it to the child process unchanged.
 *
 * @returns {{script:string, env:Record<string,string>}}
 */
export function windowsPowerShell({ target, launcher, icon, root = ROOT }) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    '$sc = $shell.CreateShortcut($env:AVC_LNK)',
    '$sc.TargetPath = $env:AVC_TARGET',
    '$sc.WorkingDirectory = $env:AVC_CWD',
    '$sc.IconLocation = $env:AVC_ICON',
    '$sc.Description = $env:AVC_DESC',
    '$sc.Save()',
    '',
  ].join('\r\n');

  return {
    script,
    env: {
      AVC_LNK: target,
      AVC_TARGET: launcher,
      AVC_CWD: root,
      AVC_ICON: icon,
      AVC_DESC: SHORTCUT_DESCRIPTION,
    },
  };
}

function createWindowsShortcut(p) {
  const { script, env } = windowsPowerShell(p);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'avc-shortcut-'));
  const file = path.join(tmp, 'shortcut.ps1');
  writeFileSync(file, script, 'ascii');
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
    const p = plan();

  if (dryRun) {
    console.log(`${remove ? '删除' : '创建'} ${p.kind}  [预览，不会写入]`);
    console.log(`  位置      ${p.target}`);
    console.log(`  指向      ${p.launcher}`);
    if (p.icon) console.log(`  图标      ${p.icon}`);
    if (p.content) {
      console.log('  内容');
      console.log(p.content.split('\n').map((l) => `    | ${l}`).join('\n'));
    }
    process.exit(0);
  }

  if (remove) {
    if (existsSync(p.target)) {
      rmSync(p.target, { force: true });
      console.log(`已删除 ${p.target}`);
    } else {
      console.log(`没有找到 ${p.target}，无需删除。`);
    }
    process.exit(0);
  }

  if (!existsSync(p.launcher)) {
    console.error(`找不到启动脚本 ${p.launcher}`);
    console.error('请在项目根目录下运行本命令。');
    process.exit(1);
  }

  try {
    mkdirSync(path.dirname(p.target), { recursive: true });
    if (platform === 'win32') {
      createWindowsShortcut(p);
    } else {
      writeFileSync(p.target, p.content, 'utf8');
      chmodSync(p.target, p.mode);
    }
  } catch (err) {
    console.error(`创建失败：${err.message}`);
    process.exit(1);
  }

  console.log(`已在桌面创建「${NAME}」`);
  console.log(`  ${p.target}`);
  console.log('');
  console.log('  以后直接双击桌面这个图标就能启动，不用再进项目目录。');
  if (platform === 'linux') {
    console.log('  GNOME 首次可能需要右键 → “允许启动 / Allow Launching”。');
  }
  console.log('');
  console.log('  项目文件夹如果换了位置，重新运行一次本命令即可。');
  console.log('  想移除：npm run shortcut:remove');
}

// Importing this module (the tests do) must not create anything: only run the
// CLI when the file is executed directly.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
