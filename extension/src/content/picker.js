import { isFillableTextInput, isVisible } from './dom-utils.js';

/**
 * Lets the user point at the code field when automatic detection misses it.
 *
 * No heuristic covers every site — plenty ship inputs named `input3` with no
 * label, no placeholder and no adjacent button. Rather than keep widening the
 * patterns and risk false positives everywhere else, let the user spend five
 * seconds teaching this one site.
 */

const HILITE = 'avc-pick-hover';
let active = null;

/** A selector that still matches after a reload, preferred most stable first. */
export function buildSelector(el) {
  const id = el.getAttribute('id');
  // Framework-generated ids (React's `:r7:`, hashes) change every render.
  if (id && !/^[:\d]/.test(id) && !/^[0-9a-f]{8,}$/i.test(id) && /^[\w-]+$/.test(id)) {
    return `#${CSS.escape(id)}`;
  }

  const name = el.getAttribute('name');
  if (name) return `input[name="${CSS.escape(name)}"]`;

  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
  if (testId) return `input[data-testid="${CSS.escape(testId)}"]`;

  // Fall back to a short structural path, anchored at the nearest stable id.
  const parts = [];
  let node = el;
  for (let depth = 0; node && depth < 5; depth += 1) {
    const parent = node.parentElement;
    if (!parent) break;
    const anchorId = parent.getAttribute?.('id');
    const index = [...parent.children].indexOf(node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
    if (anchorId && /^[\w-]+$/.test(anchorId) && !/^[:\d]/.test(anchorId)) {
      parts.unshift(`#${CSS.escape(anchorId)}`);
      return parts.join(' > ');
    }
    node = parent;
  }
  return parts.length ? parts.join(' > ') : '';
}

/** Resolves a saved selector back to a fillable, visible input. */
export function resolveSelector(selector) {
  if (!selector) return null;
  let el;
  try {
    el = document.querySelector(selector);
  } catch {
    return null;
  }
  if (!el || !isFillableTextInput(el) || !isVisible(el)) return null;
  return el;
}

export function cancelPicking() {
  if (!active) return;
  document.removeEventListener('mouseover', active.onOver, true);
  document.removeEventListener('click', active.onClick, true);
  document.removeEventListener('keydown', active.onKey, true);
  active.hovered?.classList.remove(HILITE);
  active.banner?.remove();
  active = null;
}

function flashBanner(text, tone) {
  const note = document.createElement('div');
  note.className = `avc-pick-banner${tone ? ` avc-pick-banner--${tone}` : ''}`;
  note.textContent = text;
  (document.body || document.documentElement).appendChild(note);
  setTimeout(() => note.remove(), 2600);
}

/**
 * Enters pick mode and returns immediately.
 *
 * Fire-and-forget rather than an awaited promise, because pick mode runs in
 * every frame at once — the form may live in an iframe — and because the popup
 * that started it closes the instant the user clicks the page, so there is
 * nobody left to hand a return value to. The chosen field is pushed to the
 * background, and the page itself confirms.
 *
 * @param {(result:{selector:string,label:string}) => void} onPicked
 */
export function startPicking(onPicked) {
  cancelPicking();

  const banner = document.createElement('div');
  banner.className = 'avc-pick-banner';
  banner.textContent = '点击验证码输入框（按 Esc 取消）';
  (document.body || document.documentElement).appendChild(banner);

  const onOver = (event) => {
    const el = event.target;
    if (!active || active.hovered === el) return;
    active.hovered?.classList.remove(HILITE);
    active.hovered = isFillableTextInput(el) ? el : null;
    active.hovered?.classList.add(HILITE);
  };

  const onClick = (event) => {
    const el = event.target;
    // Swallow every click while picking: the page must not react to it.
    event.preventDefault();
    event.stopPropagation();

    if (!isFillableTextInput(el)) {
      flashBanner('这不是可填写的输入框，请点验证码那一格', 'warn');
      return;
    }
    const selector = buildSelector(el);
    cancelPicking();
    if (!selector) {
      flashBanner('无法为这个元素生成稳定的定位方式', 'warn');
      return;
    }
    flashBanner('已指定，下次验证码会填到这里', 'ok');
    onPicked({ selector, label: el.getAttribute('name') || el.id || el.tagName.toLowerCase() });
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelPicking();
    }
  };

  active = { onOver, onClick, onKey, banner, hovered: null };
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}
