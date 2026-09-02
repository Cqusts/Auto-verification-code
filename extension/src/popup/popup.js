import { MSG } from '../common/constants.js';
import { sendToRuntime, sendToTab } from '../common/messaging.js';
import { updateSettings } from '../common/settings.js';
import { matchesAnyHost } from '../common/util.js';

const $ = (id) => document.getElementById(id);
let state = null;

function setMessage(text, kind = '') {
  const el = $('msg');
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.className = `msg${kind ? ` msg--${kind}` : ''}`;
}

function bridgeLabel(status, settings) {
  const wants = settings.sources.ws.enabled || settings.sources.http.enabled;
  if (!wants) return { text: '未启用', dot: '' };
  if (status.ws === 'open') return { text: 'WebSocket 已连接', dot: 'ok' };
  if (status.ws === 'connecting') return { text: '连接中…', dot: 'warn' };
  if (status.http === 'ok') return { text: 'HTTP 轮询中', dot: 'ok' };
  if (status.ws === 'error' || status.http === 'error') {
    return { text: status.lastError ? `异常：${status.lastError}`.slice(0, 40) : '连接失败', dot: 'err' };
  }
  return { text: '等待中', dot: 'warn' };
}

async function render() {
  const res = await sendToRuntime(MSG.GET_STATE);
  if (!res.ok) {
    setMessage('无法连接扩展后台，请重新加载扩展。', 'err');
    return;
  }
  state = res.data;
  const { settings, bridgeStatus, codes, activeTab } = state;

  $('master').checked = settings.enabled;

  const host = activeTab?.injectable ? activeTab.host : '';
  $('site-host').textContent = host || '（非网页标签）';
  const blocked = host && matchesAnyHost(host, settings.sites.blocklist);
  $('btn-site-toggle').textContent = blocked ? '在此站点启用' : '在此站点停用';
  $('btn-site-toggle').disabled = !host;

  const bridge = bridgeLabel(bridgeStatus, settings);
  $('bridge-state').textContent = bridge.text;
  $('dot-bridge').className = `dot${bridge.dot ? ` dot--${bridge.dot}` : ''}`;

  const latest = codes?.[0];
  if (latest) {
    const age = Math.round((Date.now() - latest.receivedAt) / 1000);
    const when = age < 60 ? `${age} 秒前` : `${Math.round(age / 60)} 分钟前`;
    $('last-code').textContent = `${latest.masked} · ${when}${latest.consumed ? ' · 已用' : ''}`;
    $('last-actions').hidden = false;
  } else {
    $('last-code').textContent = '—';
    $('last-actions').hidden = true;
  }

  await renderPageState(activeTab, settings);
}

async function renderPageState(activeTab, settings) {
  const el = $('page-state');
  const buttons = ['btn-rescan', 'btn-solve', 'btn-clip'];
  if (!activeTab?.injectable) {
    el.textContent = '不支持的页面';
    buttons.forEach((id) => ($(id).disabled = true));
    return;
  }
  if (!settings.enabled) {
    el.textContent = '扩展已关闭';
    buttons.forEach((id) => ($(id).disabled = true));
    return;
  }
  if (!activeTab.allowed) {
    el.textContent = '此站点已停用';
    buttons.forEach((id) => ($(id).disabled = true));
    return;
  }
  buttons.forEach((id) => ($(id).disabled = false));

  // Frame 0 keeps the answer deterministic; fields inside iframes still show up
  // because the background registers them by frame.
  const ping = await sendToTab(activeTab.id, MSG.PING, {}, { frameId: 0 });
  if (!ping.ok) {
    el.textContent = '页面未注入（请刷新）';
    return;
  }
  const parts = [];
  const otpCount = (ping.data?.otp ? 1 : 0) + (activeTab.registeredFields || 0);
  if (otpCount) parts.push('已找到验证码输入框');
  if (ping.data?.captchas) parts.push(`${ping.data.captchas} 个图片验证码`);
  el.textContent = parts.length ? parts.join(' · ') : '未发现验证码字段';
}

async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$('master').addEventListener('change', async (event) => {
  await updateSettings({ enabled: event.target.checked });
  setMessage(event.target.checked ? '已开启' : '已关闭', 'ok');
  await render();
});

$('btn-site-toggle').addEventListener('click', async () => {
  const host = state?.activeTab?.injectable ? state.activeTab.host : '';
  if (!host) return;
  const list = new Set(state.settings.sites.blocklist || []);
  if (list.has(host)) list.delete(host);
  else list.add(host);
  await updateSettings({ sites: { blocklist: [...list] } });
  setMessage('站点规则已更新，刷新页面后生效。', 'ok');
  await render();
});

$('btn-rescan').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const res = await sendToRuntime(MSG.RESCAN_ACTIVE_TAB);
    setMessage(res.ok ? '已重新扫描页面。' : `扫描失败：${res.error}`, res.ok ? 'ok' : 'err');
    await render();
  }),
);

$('btn-solve').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const res = await sendToRuntime(MSG.SOLVE_ACTIVE_TAB);
    const data = res.data?.data ?? res.data;
    if (!res.ok) setMessage(`识别失败：${res.error}`, 'err');
    else if (data?.ok) setMessage(`识别结果：${data.text}（${data.confidence}%）`, 'ok');
    else setMessage(`未能识别：${data?.reason || '未知原因'}`, 'err');
  }),
);

$('btn-clip').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const tabId = state?.activeTab?.id;
    if (!tabId) return;
    const res = await sendToTab(tabId, MSG.READ_CLIPBOARD, {});
    const data = res.data;
    if (data?.ok) setMessage(`已从剪贴板填入 ${data.code}`, 'ok');
    else setMessage(`剪贴板未找到验证码（${data?.reason || res.error}）`, 'err');
  }),
);

$('btn-fill-last').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const tabId = state?.activeTab?.id;
    const latest = state?.codes?.[0];
    if (!tabId || !latest) return;
    const codeRes = await sendToRuntime(MSG.REQUEST_LATEST_CODE);
    const code = codeRes.data?.code;
    if (!code) {
      setMessage('验证码已过期。', 'err');
      return;
    }
    const res = await sendToTab(tabId, MSG.FILL_TEXT, { code, codeId: latest.id });
    setMessage(res.data?.filled ? '已填入。' : `填写失败：${res.data?.reason || res.error}`, res.data?.filled ? 'ok' : 'err');
  }),
);

$('btn-manual').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const text = $('manual').value.trim();
    if (!text) {
      setMessage('请输入验证码或短信内容。', 'err');
      return;
    }
    const res = await sendToRuntime(MSG.SUBMIT_MANUAL_CODE, { text });
    if (!res.ok) {
      setMessage(`解析失败：${res.error}`, 'err');
      return;
    }
    const data = res.data;
    if (data.delivered) setMessage('已解析并填入页面。', 'ok');
    else if (data.stored) setMessage('已解析，但页面上没有可填写的输入框。', '');
    else setMessage(`未识别出验证码（${data.reason}）`, 'err');
    $('manual').value = '';
    await render();
  }),
);

$('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('btn-clear').addEventListener('click', async () => {
  await sendToRuntime(MSG.CLEAR_HISTORY);
  setMessage('已清空验证码记录与日志。', 'ok');
  await render();
});

render();
