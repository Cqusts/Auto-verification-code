import { MSG } from '../common/constants.js';
import { sendToRuntime } from '../common/messaging.js';
import { getSettings, updateSettings, replaceSettings, resetSettings } from '../common/settings.js';
import { clamp } from '../common/util.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// declarative binding: every control carries data-path="a.b.c"
// ---------------------------------------------------------------------------

function readPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** Builds the minimal nested patch for one path, e.g. "a.b" -> {a:{b:value}}. */
function patchFor(path, value) {
  const keys = path.split('.');
  const patch = {};
  let node = patch;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) node[key] = value;
    else {
      node[key] = {};
      node = node[key];
    }
  });
  return patch;
}

function controlValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'lines') {
    return el.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (el.type === 'number') {
    const min = el.min === '' ? -Infinity : Number(el.min);
    const max = el.max === '' ? Infinity : Number(el.max);
    return clamp(Number(el.value), min, max);
  }
  return el.value;
}

function applyValue(el, value) {
  if (el.type === 'checkbox') el.checked = Boolean(value);
  else if (el.dataset.type === 'lines') el.value = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  else el.value = value ?? '';
}

let savedTimer = null;
function flashSaved() {
  const el = $('saved');
  el.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    el.hidden = true;
  }, 1200);
}

async function bind() {
  const settings = await getSettings({ fresh: true });
  for (const el of document.querySelectorAll('[data-path]')) {
    applyValue(el, readPath(settings, el.dataset.path));
    const event = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(event, async () => {
      let value = controlValue(el);
      // Keep the length range coherent no matter which end the user edits.
      if (el.dataset.path === 'otp.minLength') {
        const maxEl = document.querySelector('[data-path="otp.maxLength"]');
        if (maxEl && Number(maxEl.value) < value) {
          maxEl.value = value;
          await updateSettings(patchFor('otp.maxLength', value));
        }
      }
      if (el.dataset.path === 'otp.maxLength') {
        const minEl = document.querySelector('[data-path="otp.minLength"]');
        if (minEl && Number(minEl.value) > value) value = Number(minEl.value);
        applyValue(el, value);
      }
      await updateSettings(patchFor(el.dataset.path, value));
      flashSaved();
    });
  }
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------

$('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('tab--active', el === tab));
  document.querySelectorAll('.panel').forEach((el) => {
    el.classList.toggle('panel--active', el.dataset.panel === tab.dataset.tab);
  });
  location.hash = tab.dataset.tab;
});

function restoreTab() {
  const wanted = location.hash.replace('#', '');
  const tab = wanted && document.querySelector(`.tab[data-tab="${CSS.escape(wanted)}"]`);
  if (tab) tab.click();
}

// ---------------------------------------------------------------------------
// connectivity tests
// ---------------------------------------------------------------------------

function showResult(id, ok, text) {
  const el = $(id);
  el.textContent = text;
  el.className = `test-result test-result--${ok ? 'ok' : 'err'}`;
}

$('btn-test-ws').addEventListener('click', async () => {
  const settings = await getSettings({ fresh: true });
  showResult('result-ws', true, '测试中…');
  const res = await sendToRuntime(MSG.TEST_BRIDGE, { kind: 'ws', config: settings.sources.ws });
  const data = res.data?.data ?? res.data;
  if (res.ok && data?.ok) showResult('result-ws', true, '连接成功');
  else showResult('result-ws', false, `失败：${data?.error || res.error || '未知错误'}`);
});

$('btn-test-http').addEventListener('click', async () => {
  const settings = await getSettings({ fresh: true });
  showResult('result-http', true, '测试中…');
  const res = await sendToRuntime(MSG.TEST_BRIDGE, { kind: 'http', config: settings.sources.http });
  const data = res.data?.data ?? res.data;
  if (res.ok && data?.ok) {
    const sample = data.sample ? `，示例：${data.sample.slice(0, 40)}` : '';
    showResult('result-http', true, `成功（${data.ms}ms，解析到 ${data.found} 条${sample}）`);
  } else {
    showResult('result-http', false, `失败：${data?.error || res.error || '未知错误'}`);
  }
});

// ---------------------------------------------------------------------------
// optional permissions
// ---------------------------------------------------------------------------

async function requestPermission(button, permission, label) {
  const granted = await chrome.permissions.request({ permissions: [permission] }).catch(() => false);
  button.textContent = granted ? `${label}已授予` : `${label}被拒绝`;
  setTimeout(() => {
    button.textContent = `授予${label}`;
  }, 2500);
}

$('btn-perm-clip').addEventListener('click', (e) => requestPermission(e.target, 'clipboardRead', '剪贴板权限'));
$('btn-perm-notify').addEventListener('click', (e) => requestPermission(e.target, 'notifications', '通知权限'));

// ---------------------------------------------------------------------------
// OCR test bench
// ---------------------------------------------------------------------------

async function runOcrTest(dataUrl) {
  $('ocr-out').hidden = false;
  $('ocr-src').src = dataUrl;
  $('ocr-prep').removeAttribute('src');
  $('ocr-text').textContent = '识别中…';

  const res = await sendToRuntime(MSG.TEST_OCR, { dataUrl });
  if (!res.ok) {
    $('ocr-text').textContent = `识别失败：${res.error}`;
    return;
  }
  const data = res.data;
  if (data.preview) $('ocr-prep').src = data.preview;
  $('ocr-text').innerHTML = data.text
    ? `识别结果：<strong>${escapeHtml(data.text)}</strong> · 置信度 ${data.confidence}% · 方案 ${escapeHtml(data.variant)} · 尝试 ${data.attempts} 次`
    : `未识别出字符（置信度 ${data.confidence}%）`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const dropzone = $('dropzone');
dropzone.addEventListener('click', () => $('ocr-file').click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') $('ocr-file').click();
});
$('ocr-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) await runOcrTest(await fileToDataUrl(file));
});
['dragenter', 'dragover'].forEach((type) =>
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('dropzone--over');
  }),
);
['dragleave', 'drop'].forEach((type) =>
  dropzone.addEventListener(type, () => dropzone.classList.remove('dropzone--over')),
);
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) await runOcrTest(await fileToDataUrl(file));
});
addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  const file = item.getAsFile();
  if (file) await runOcrTest(await fileToDataUrl(file));
});

// ---------------------------------------------------------------------------
// backup / logs
// ---------------------------------------------------------------------------

$('btn-export').addEventListener('click', async () => {
  const settings = await getSettings({ fresh: true });
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `auto-verification-code-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    await replaceSettings(parsed);
    await bind();
    flashSaved();
  } catch (err) {
    alert(`导入失败：${err.message}`);
  }
  e.target.value = '';
});

$('btn-reset').addEventListener('click', async () => {
  if (!confirm('确定要恢复所有默认设置吗？')) return;
  await resetSettings();
  await bind();
  flashSaved();
});

$('btn-logs').addEventListener('click', async () => {
  const res = await sendToRuntime(MSG.GET_LOGS);
  const logs = res.data?.logs || [];
  $('logs').textContent = logs.length
    ? logs
        .map((l) => {
          const time = new Date(l.t).toLocaleTimeString();
          const detail = l.detail === undefined ? '' : ` ${JSON.stringify(l.detail)}`;
          return `${time} [${l.level}] ${l.scope}: ${l.message}${detail}`;
        })
        .join('\n')
    : '（暂无日志。可在上方开启「输出调试日志」以获得更多细节。）';
});

$('btn-clear-logs').addEventListener('click', async () => {
  await sendToRuntime(MSG.CLEAR_HISTORY);
  $('logs').textContent = '（已清空）';
});

// ---------------------------------------------------------------------------

bind().then(restoreTab);
