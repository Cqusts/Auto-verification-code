import { MSG } from '../common/constants.js';
import { sendToRuntime } from '../common/messaging.js';
import { updateSettings } from '../common/settings.js';
import { matchesAnyHost } from '../common/util.js';

const $ = (id) => document.getElementById(id);
let state = null;

/** Chrome's raw messaging errors are useless to a user; say what to do instead. */
const ERROR_TEXT = {
  'no-active-tab': '找不到当前标签页。',
  'not-injectable': '浏览器内置页面不允许扩展运行，请在普通网页上使用。',
  'no-code': '没有可用的验证码，或已超过有效期。',
  'no-captcha': '此页面上没有找到图片验证码。',
  'site-not-allowed': '此站点已在设置中停用。',
  'rate-limited': '识别过于频繁，请稍候再试。',
  'captcha-disabled': '图片验证码识别已关闭。',
};

function explain(error) {
  const key = String(error || '');
  if (ERROR_TEXT[key]) return ERROR_TEXT[key];
  if (/Receiving end does not exist|Could not establish connection/i.test(key)) {
    return '页面脚本未注入，请刷新该页面后重试。';
  }
  return key || '未知错误';
}

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

  renderPageState(activeTab, settings);
}

function renderPageState(activeTab, settings) {
  const el = $('page-state');
  const buttons = ['btn-rescan', 'btn-solve', 'btn-clip'];
  const disable = (text) => {
    el.textContent = text;
    buttons.forEach((id) => ($(id).disabled = true));
  };

  if (!activeTab?.injectable) return disable('不支持的页面');
  if (!settings.enabled) return disable('扩展已关闭');
  if (!activeTab.allowed) return disable('此站点已停用');
  buttons.forEach((id) => ($(id).disabled = false));

  // The background already pinged the page (injecting first if the tab predates
  // the extension), so this is just a readout.
  const page = activeTab.page;
  if (!page?.injected) {
    el.textContent = '页面脚本未注入（请刷新页面）';
    return;
  }
  const parts = [];
  if (page.otp || activeTab.registeredFields) parts.push('已找到验证码输入框');
  if (page.captchas) parts.push(`${page.captchas} 个图片验证码`);
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
    setMessage(res.ok ? '已重新扫描页面。' : `扫描失败：${explain(res.error)}`, res.ok ? 'ok' : 'err');
    await render();
  }),
);

$('btn-solve').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const res = await sendToRuntime(MSG.SOLVE_ACTIVE_TAB);
    if (!res.ok) setMessage(`识别失败：${explain(res.error)}`, 'err');
    else if (res.data?.ok) setMessage(`识别结果：${res.data.text}（${res.data.confidence}%）`, 'ok');
    else setMessage(`未能识别：${explain(res.data?.reason)}`, 'err');
  }),
);

$('btn-clip').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const res = await sendToRuntime(MSG.CLIPBOARD_ACTIVE_TAB);
    if (!res.ok) setMessage(`读取失败：${explain(res.error)}`, 'err');
    else if (res.data?.ok) setMessage(`已从剪贴板填入 ${res.data.code}`, 'ok');
    else setMessage(`剪贴板里没有验证码（${explain(res.data?.reason)}）`, 'err');
  }),
);

$('btn-fill-last').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const res = await sendToRuntime(MSG.FILL_ACTIVE_TAB);
    if (!res.ok) setMessage(`填写失败：${explain(res.error)}`, 'err');
    else if (res.data?.filled) setMessage('已填入。', 'ok');
    else setMessage(`填写失败：${explain(res.data?.reason)}`, 'err');
    await render();
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
    else if (data.stored) setMessage('已解析。页面上暂无可填写的输入框，可点上方「填入当前页面」。', '');
    else setMessage(`未识别出验证码（${explain(data.reason)}）`, 'err');
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
