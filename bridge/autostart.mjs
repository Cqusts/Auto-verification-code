#!/usr/bin/env node
/**
 * Installs, removes and inspects the "start the SMS bridge with my machine"
 * service for the current user.
 *
 *   node bridge/autostart.mjs install     [--port 8787] [--host 0.0.0.0]
 *   node bridge/autostart.mjs uninstall
 *   node bridge/autostart.mjs status
 *
 * Extra flags:
 *   --dry-run             print every file and command instead of applying them
 *   --platform win32      preview another OS's setup (implies --dry-run)
 *
 * Nothing here needs administrator rights: everything is installed per-user
 * (systemd --user / LaunchAgent / the Startup folder), so removing it is
 * always just deleting a file the same user owns.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { paths, resolveToken, tokenFile } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'bridge', 'server.mjs');
const LABEL = 'auto-verification-code-bridge';
const MAC_LABEL = 'com.auto-verification-code.bridge';

const argv = process.argv.slice(2);
const action = argv.find((a) => !a.startsWith('--')) || 'status';
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const platform = flag('platform', process.platform);
// --platform exists to preview another OS's setup, so it never touches this one.
const dryRun = has('dry-run') || argv.includes('--platform');
const port = Number(flag('port', 8787));
const host = flag('host', '0.0.0.0');

/** Path helper for the *target* platform, so previews print real Windows paths. */
const P = () => (platform === 'win32' ? path.win32 : path.posix);

const xmlEscape = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const vbsQuote = (s) => `"${String(s).replace(/"/g, '""')}"`;

// ---------------------------------------------------------------------------
// per-platform definitions
// ---------------------------------------------------------------------------

function linuxPlan() {
  const { join } = P();
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'systemd', 'user');
  const unit = join(unitDir, `${LABEL}.service`);
  return {
    label: 'systemd user service',
    files: [
      {
        path: unit,
        content: `[Unit]
Description=Auto Verification Code — SMS bridge
Documentation=https://github.com/Cqusts/Auto-verification-code
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${process.execPath} ${SERVER} --port ${port} --host ${host} --quiet
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
      },
    ],
    install: [
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', `${LABEL}.service`]],
    ],
    uninstall: [['systemctl', ['--user', 'disable', '--now', `${LABEL}.service`]]],
    afterUninstall: [['systemctl', ['--user', 'daemon-reload']]],
    statusCmd: ['systemctl', ['--user', 'is-active', `${LABEL}.service`]],
    manualDisable: [
      `systemctl --user disable --now ${LABEL}.service`,
      `rm ${unit}`,
      'systemctl --user daemon-reload',
    ],
    notes: [
      '若希望注销后仍保持运行：sudo loginctl enable-linger $USER',
      `查看日志：journalctl --user -u ${LABEL} -f`,
    ],
  };
}

function macPlan() {
  const { join } = P();
  const plist = join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
  const log = paths(platform).log;
  const args = [process.execPath, SERVER, '--port', String(port), '--host', host, '--quiet'];
  return {
    label: 'LaunchAgent',
    files: [
      {
        path: plist,
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`,
      },
    ],
    install: [['launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, plist]]],
    uninstall: [['launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${MAC_LABEL}`]]],
    statusCmd: ['launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${MAC_LABEL}`]],
    manualDisable: [`launchctl bootout gui/$(id -u)/${MAC_LABEL}`, `rm ${plist}`],
    notes: [`查看日志：tail -f ${log}`],
  };
}

function windowsPlan() {
  const { join } = P();
  const home = os.homedir();
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const startup = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbs = join(startup, `${LABEL}.vbs`);
  const { data, log } = paths(platform);
  const cmd = join(data, 'bridge.cmd');
  return {
    label: '启动文件夹（当前用户，无需管理员权限）',
    files: [
      {
        path: cmd,
        content: `@echo off\r
rem Auto Verification Code — SMS bridge\r
rem Generated by bridge/autostart.mjs\r
cd /d "${ROOT}"\r
"${process.execPath}" "${SERVER}" --port ${port} --host ${host} --quiet >> "${log}" 2>&1\r
`,
      },
      {
        path: vbs,
        content: `' Auto Verification Code — SMS bridge (autostart)\r
' Generated by bridge/autostart.mjs. Deleting this file disables autostart.\r
Set shell = CreateObject("WScript.Shell")\r
shell.Run ${vbsQuote(cmd)}, 0, False\r
`,
      },
    ],
    install: [],
    uninstall: [],
    statusCmd: null,
    manualDisable: [
      '按 Win+R，输入 shell:startup，回车',
      `删除其中的 ${LABEL}.vbs`,
      `（可选）删除 ${cmd}`,
    ],
    notes: [
      '下次登录 Windows 时生效；现在就想启动可以双击那个 .vbs 文件。',
      `查看日志：${log}`,
      '卸载后，当前已在运行的实例会持续到注销或重启；也可在任务管理器里结束对应的 node.exe。',
    ],
  };
}

function planFor(target) {
  if (target === 'linux') return linuxPlan();
  if (target === 'darwin') return macPlan();
  if (target === 'win32') return windowsPlan();
  throw new Error(`unsupported platform: ${target}`);
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function run([cmd, args], { optional = false } = {}) {
  if (dryRun) {
    console.log(`  $ ${cmd} ${args.join(' ')}`);
    return true;
  }
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    console.log(`  ran: ${cmd} ${args.join(' ')}`);
    return true;
  } catch (err) {
    // The real reason is usually the *last* stderr line; earlier ones are progress notes.
    const lines = String(err.stderr || err.message).trim().split('\n').filter(Boolean);
    console.log(`  ${optional ? 'skipped' : 'failed'}: ${cmd} ${args.join(' ')}`);
    console.log(`    ${lines[lines.length - 1] || 'unknown error'}`);
    return false;
  }
}

/**
 * The only check that really matters: is anything answering on the port?
 * Service managers report their own state, which is not the same question.
 */
async function reportLive({ retries = 1 } = {}) {
  const token = existsSync(tokenFile(platform)) ? readFileSync(tokenFile(platform), 'utf8').trim() : '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(2500),
      });
      const body = await res.json();
      console.log(`\n  正在运行  http://127.0.0.1:${port}  已连接扩展 ${body.clients} 个`);
      if (token) console.log(`  令牌      ${token}`);
      return true;
    } catch {
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  console.log(`\n  端口 ${port} 无响应 —— 桥接服务当前没有在运行。`);
  if (token) console.log(`  令牌      ${token}`);
  return false;
}

async function install(plan) {
  const { token } = dryRun ? { token: '（安装时生成）' } : resolveToken('');
  console.log(`安装自启（${plan.label}）${dryRun ? ' [dry-run]' : ''}\n`);

  for (const file of plan.files) {
    if (dryRun) {
      console.log(`  写入 ${file.path}`);
      console.log(
        file.content
          .split('\n')
          .map((l) => `    | ${l}`)
          .join('\n'),
      );
    } else {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, 'utf8');
      console.log(`  写入 ${file.path}`);
    }
  }

  if (plan.install.length) console.log('');
  for (const command of plan.install) run(command);

  console.log('\n完成。扩展设置 → 短信来源 → WebSocket 推送：');
  console.log(`  地址   ws://127.0.0.1:${port}/ws`);
  console.log(`  令牌   ${token}`);
  console.log(`\n令牌保存在 ${tokenFile(platform)}，重启后不会变化。`);
  if (plan.notes.length) {
    console.log('');
    for (const note of plan.notes) console.log(`  · ${note}`);
  }
  if (!dryRun) {
    // Service-manager output can be noisy or partial; this is the honest answer.
    const live = await reportLive({ retries: 2 });
    if (!live) {
      console.log('\n  服务没有起来。手动跑一次看具体报错：');
      console.log(`    node bridge/server.mjs --port ${port}`);
    }
  }
  console.log(`\n关闭自启：node bridge/autostart.mjs uninstall`);
}

function uninstall(plan) {
  console.log(`关闭自启（${plan.label}）${dryRun ? ' [dry-run]' : ''}\n`);
  // Stop/disable first, so nothing is left pointing at files we are deleting.
  for (const command of plan.uninstall) run(command, { optional: true });

  for (const file of plan.files) {
    if (dryRun) {
      console.log(`  删除 ${file.path}`);
    } else if (existsSync(file.path)) {
      rmSync(file.path, { force: true });
      console.log(`  删除 ${file.path}`);
    } else {
      console.log(`  已不存在 ${file.path}`);
    }
  }
  for (const command of plan.afterUninstall || []) run(command, { optional: true });

  console.log('\n自启已关闭。');
  console.log(`令牌文件 ${tokenFile(platform)} 保留（重新安装时会沿用）。要彻底清除请手动删除它。`);
  if (plan.notes.length) {
    console.log('');
    for (const note of plan.notes) console.log(`  · ${note}`);
  }
}

async function status(plan) {
  console.log(`自启状态（${plan.label}）\n`);
  for (const file of plan.files) {
    console.log(`  ${existsSync(file.path) ? '已安装' : '未安装'}  ${file.path}`);
  }
  if (plan.statusCmd && !dryRun) {
    try {
      const out = execFileSync(plan.statusCmd[0], plan.statusCmd[1], { stdio: 'pipe' }).toString().trim();
      console.log(`  服务状态  ${out.split('\n')[0]}`);
    } catch (err) {
      const out = String(err.stdout || err.message).trim().split('\n')[0];
      console.log(`  服务状态  ${out || '未运行'}`);
    }
  }

  await reportLive();
  console.log(`\n安装：node bridge/autostart.mjs install\n关闭：node bridge/autostart.mjs uninstall`);
}

// ---------------------------------------------------------------------------

const plan = planFor(platform);
if (action === 'install') await install(plan);
else if (action === 'uninstall') uninstall(plan);
else if (action === 'status') await status(plan);
else {
  console.error(`未知操作：${action}\n用法：node bridge/autostart.mjs install|uninstall|status`);
  process.exitCode = 1;
}
