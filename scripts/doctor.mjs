#!/usr/bin/env node
/**
 * Localises "手机发不过来" to a single hop.
 *
 * Every check is independent and failure-tolerant: a check that cannot run says
 * so and the rest continue, because a diagnostic that dies on its first problem
 * is worse than no diagnostic.
 *
 *   node scripts/doctor.mjs [--port 8787]
 */
import { execFileSync } from 'node:child_process';
import { rankAddresses } from '../bridge/net.mjs';
import { readToken, tokenFile } from '../bridge/config.mjs';

const argv = process.argv.slice(2);
const port = Number((() => {
  const i = argv.indexOf('--port');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : 8787;
})());

const ok = (t) => console.log(`  ✓ ${t}`);
const bad = (t) => console.log(`  ✗ ${t}`);
const info = (t) => console.log(`    ${t}`);
const head = (t) => console.log(`\n${t}\n${'-'.repeat(40)}`);

/** Runs PowerShell and returns stdout, or null when it cannot be used. */
function powershell(command) {
  if (process.platform !== 'win32') return null;
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

console.log('Auto Verification Code — 网络自检');

// --- 1. is the bridge up? ---------------------------------------------------
head('1. 桥接服务');
let running = false;
let clients = 0;
try {
  const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2500) });
  const body = await res.json();
  running = true;
  clients = body.clients ?? 0;
  ok(`正在运行，端口 ${port}`);
  console.log(
    clients > 0
      ? `  ✓ 扩展已连接（${clients} 个）`
      : '  ✗ 扩展还没连上 —— 去扩展设置 → 短信来源 → WebSocket 推送，点「测试连接」',
  );
} catch {
  bad(`端口 ${port} 没有响应 —— 桥接服务没在运行`);
  info('先双击 start-bridge.cmd（或 npm run bridge），然后重新运行本自检。');
}

const token = readToken();
if (token) ok(`令牌：${token}`);
else info(`还没有令牌文件（${tokenFile()}），第一次启动服务时会生成。`);

// --- 2. which address should the phone use? ---------------------------------
head('2. 手机该用哪个地址');
const addresses = rankAddresses();
if (addresses.length === 0) {
  bad('没有找到可用的网卡 —— 电脑没连上网络？');
} else {
  info('按「手机最可能连得上」排序：');
  for (const [i, a] of addresses.entries()) {
    const mark = i === 0 ? '← 优先用这个' : a.virtual ? '← 虚拟网卡，手机连不上' : '';
    console.log(`      http://${a.address}:${port}    ${a.name}  ${mark}`);
  }
}

// --- 3. Windows specifics: the two things that cause a silent timeout -------
if (process.platform === 'win32') {
  head('3. Windows 网络与防火墙');

  const profiles = powershell(
    'Get-NetConnectionProfile | ForEach-Object { "$($_.Name)|$($_.NetworkCategory)" }',
  );
  if (profiles === null) {
    info('无法查询网络配置（PowerShell 不可用），请手动确认。');
  } else if (!profiles) {
    info('没有检测到活动网络连接。');
  } else {
    for (const line of profiles.split('\n')) {
      const [name, category] = line.split('|').map((x) => x.trim());
      if (/Private/i.test(category)) ok(`网络「${name}」是专用网络`);
      else {
        bad(`网络「${name}」是${/Public/i.test(category) ? '公用' : category}网络`);
        info('公用网络下 Windows 会阻止几乎所有入站连接，手机一定连不上。');
        info('改：设置 → 网络和 Internet → WLAN → 点当前网络 → 网络配置文件类型 → 专用网络');
      }
    }
  }

  const rules = powershell(
    `$p = Get-NetFirewallPortFilter -ErrorAction SilentlyContinue | Where-Object { $_.Protocol -eq 'TCP' -and ($_.LocalPort -contains '${port}' -or $_.LocalPort -eq 'Any') };` +
      "$p | ForEach-Object { $_ | Get-NetFirewallRule -ErrorAction SilentlyContinue } | " +
      "Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | " +
      'Select-Object -First 5 -ExpandProperty DisplayName',
  );
  if (rules === null) {
    info('无法查询防火墙规则，请手动确认。');
  } else if (rules) {
    ok(`防火墙有放行 ${port} 的入站规则：`);
    for (const r of rules.split('\n').slice(0, 5)) info(`  ${r.trim()}`);
  } else {
    bad(`没有找到放行 TCP ${port} 的入站规则`);
    info('在管理员 PowerShell 里执行：');
    info(`  New-NetFirewallRule -DisplayName "Auto Verification Code" \`` );
    info(`    -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private`);
  }
}

// --- 4. the decisive test ---------------------------------------------------
head(`${process.platform === 'win32' ? '4' : '3'}. 用手机验证`);
const best = addresses[0]?.address;
if (!running) {
  info('桥接服务没在跑，先启动它。');
} else if (!best) {
  info('没有可用地址。');
} else {
  console.log('  拿起手机，确认连的是同一个 Wi-Fi（关掉移动数据），用浏览器打开：');
  console.log('');
  console.log(`      http://${best}:${port}/status`);
  console.log('');
  info('看到一段 JSON  → 网络通了。剩下的问题在快捷指令配置里。');
  info('转圈到超时      → 网络不通。回到上面标 ✗ 的那几项。');
  info('');
  info('手机连上的瞬间，桥接服务那个窗口会打印一行「✓ 收到来自 … 的请求」。');
}

console.log('');
