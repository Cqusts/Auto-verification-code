/** DOM helpers that survive shadow roots, framework-managed inputs and odd layouts. */

const TEXT_INPUT_TYPES = new Set(['text', 'tel', 'number', 'search', 'url', '']);

/** Query across the document *and* every open shadow root. */
export function deepQueryAll(selector, root = document, limit = 400) {
  const out = [];
  const walk = (node, depth) => {
    if (out.length >= limit || depth > 8) return;
    let found;
    try {
      found = node.querySelectorAll(selector);
    } catch {
      return;
    }
    for (const el of found) {
      out.push(el);
      if (out.length >= limit) return;
    }
    let hosts;
    try {
      hosts = node.querySelectorAll('*');
    } catch {
      return;
    }
    for (const el of hosts) {
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      if (out.length >= limit) return;
    }
  };
  walk(root, 0);
  return out;
}

export function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  if (Number(style.opacity) === 0) return false;
  return true;
}

export function isInViewport(el, margin = 0) {
  const rect = el.getBoundingClientRect();
  return (
    rect.bottom > -margin &&
    rect.right > -margin &&
    rect.top < (window.innerHeight || 0) + margin &&
    rect.left < (window.innerWidth || 0) + margin
  );
}

export function isFillableTextInput(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.disabled || el.readOnly) return false;
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (!TEXT_INPUT_TYPES.has(type)) return false;
  return true;
}

/** Everything a human would read to work out what an input is for. */
export function describeField(el) {
  const bits = [
    el.getAttribute('name'),
    el.id,
    el.className,
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    el.getAttribute('autocomplete'),
    el.getAttribute('title'),
    el.getAttribute('data-testid'),
    el.getAttribute('inputmode'),
  ];

  if (el.id) {
    try {
      const label = el.getRootNode().querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) bits.push(label.textContent);
    } catch {
      /* invalid id for a selector */
    }
  }
  const wrappingLabel = el.closest?.('label');
  if (wrappingLabel) bits.push(wrappingLabel.textContent);

  const described = el.getAttribute('aria-labelledby');
  if (described) {
    for (const id of described.split(/\s+/)) {
      const node = el.getRootNode().getElementById?.(id);
      if (node) bits.push(node.textContent);
    }
  }

  // Nearby text: the previous sibling and the parent's own leading text.
  const prev = el.previousElementSibling;
  if (prev && prev.textContent && prev.textContent.length < 40) bits.push(prev.textContent);
  const parent = el.parentElement;
  if (parent && parent.childElementCount <= 6) {
    const text = [...parent.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent.trim())
      .join(' ');
    if (text && text.length < 60) bits.push(text);
  }

  return bits.filter(Boolean).join(' ').slice(0, 600);
}

/**
 * Nearest form-ish container to search for buttons and CAPTCHA images.
 *
 * Never widens to <body>: a page-wide scope makes every field look like it has a
 * "send code" button next to it, which mis-classifies unrelated inputs.
 */
export function containerOf(el, levels = 4) {
  const grouping = el.closest?.('form, fieldset, [role="form"], [role="dialog"], dialog');
  if (grouping && grouping !== document.body) return grouping;
  let node = el.parentElement;
  let best = el.parentElement || el;
  for (let i = 0; i < levels; i += 1) {
    if (!node || node === document.body || node === document.documentElement) break;
    best = node;
    node = node.parentElement;
  }
  return best;
}

/**
 * Writes a value the way a real keystroke would, so React/Vue/Angular notice.
 * Assigning `.value` directly is swallowed by React's value tracker.
 */
export function setNativeValue(el, value) {
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;
}

export function fireEvent(el, type, init = {}) {
  el.dispatchEvent(new Event(type, { bubbles: true, composed: true, ...init }));
}

export function fireKey(el, type, key) {
  el.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

/** Absolute rect in the *top* window's viewport, for screenshot cropping. */
export function topViewportRect(el) {
  const rect = el.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  let win = window;
  try {
    while (win !== win.parent) {
      const frame = win.frameElement;
      if (!frame) return null; // cross-origin: cannot map coordinates
      const frameRect = frame.getBoundingClientRect();
      x += frameRect.left;
      y += frameRect.top;
      win = win.parent;
    }
  } catch {
    return null;
  }
  return { x, y, width: rect.width, height: rect.height };
}

export function textOf(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}
