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

function cleanup() {
  if (!active) return;
  document.removeEventListener('mouseover', active.onOver, true);
  document.removeEventListener('click', active.onClick, true);
  document.removeEventListener('keydown', active.onKey, true);
  active.hovered?.classList.remove(HILITE);
  active.banner?.remove();
  active = null;
}

/**
 * Enters pick mode until the user clicks an input or presses Escape.
 * @returns {Promise<{selector:string, label:string}|{cancelled:true}>}
 */
export function pickField() {
  cleanup();
  return new Promise((resolve) => {
    const banner = document.createElement('div');
    banner.className = 'avc-pick-banner';
    banner.textContent = '点击页面上的验证码输入框（按 Esc 取消）';
    (document.body || document.documentElement).appendChild(banner);

    const finish = (result) => {
      cleanup();
      resolve(result);
    };

    const onOver = (event) => {
      const el = event.target;
      if (active.hovered === el) return;
      active.hovered?.classList.remove(HILITE);
      active.hovered = isFillableTextInput(el) ? el : null;
      active.hovered?.classList.add(HILITE);
    };

    const onClick = (event) => {
      const el = event.target;
      if (!isFillableTextInput(el)) return;
      // Never let the page act on this click.
      event.preventDefault();
      event.stopPropagation();
      const selector = buildSelector(el);
      finish(selector ? { selector, label: el.getAttribute('name') || el.id || el.tagName.toLowerCase() } : { cancelled: true });
    };

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish({ cancelled: true });
      }
    };

    active = { onOver, onClick, onKey, banner, hovered: null };
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
}
