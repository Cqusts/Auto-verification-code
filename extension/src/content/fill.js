import { SUBMIT_BUTTON_RE } from '../common/patterns.js';
import { setNativeValue, fireEvent, fireKey, isVisible, containerOf, textOf } from './dom-utils.js';
import { sleep } from '../common/util.js';

/**
 * Types a value into a single input the way a keyboard would.
 * The per-character path matters: plenty of login forms only enable their submit
 * button after counting keydown events, and React ignores a plain `.value =`.
 */
export async function typeInto(el, text, { perChar = true, delay = 10 } = {}) {
  el.focus({ preventScroll: true });
  if (el.value) {
    setNativeValue(el, '');
    fireEvent(el, 'input');
  }

  if (!perChar) {
    setNativeValue(el, text);
    fireEvent(el, 'input');
    fireEvent(el, 'change');
    return el.value === text;
  }

  let acc = '';
  for (const ch of text) {
    fireKey(el, 'keydown', ch);
    acc += ch;
    setNativeValue(el, acc);
    fireEvent(el, 'input');
    fireKey(el, 'keyup', ch);
    if (delay) await sleep(delay);
  }
  fireEvent(el, 'change');
  return el.value === text;
}

/** Fires a genuine paste event; some OTP widgets only implement onPaste. */
function tryPaste(el, text) {
  try {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    el.focus({ preventScroll: true });
    const event = new ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return true;
  } catch {
    return false;
  }
}

/** Distributes one character per box across a split code widget. */
export async function fillDigitGroup(inputs, text) {
  const chars = String(text).slice(0, inputs.length).split('');

  // Many widgets spread a pasted code across all boxes for us.
  if (tryPaste(inputs[0], text)) {
    await sleep(60);
    const joined = inputs.map((el) => el.value).join('');
    if (joined === text.slice(0, inputs.length)) return true;
  }

  for (let i = 0; i < chars.length; i += 1) {
    const el = inputs[i];
    el.focus({ preventScroll: true });
    setNativeValue(el, '');
    fireKey(el, 'keydown', chars[i]);
    setNativeValue(el, chars[i]);
    fireEvent(el, 'input');
    fireKey(el, 'keyup', chars[i]);
    await sleep(25);
  }
  fireEvent(inputs[inputs.length - 1], 'change');
  return inputs.map((el) => el.value).join('') === chars.join('');
}

/** Writes `text` into either a single input or its split-box group. */
export async function fillField({ input, group }, text) {
  if (group && group.length) return fillDigitGroup(group, text);
  return typeInto(input, text);
}

export function findSubmitButton(el) {
  const scope = containerOf(el, 4);
  const explicit = scope.querySelector('button[type="submit"], input[type="submit"]');
  if (explicit && isVisible(explicit) && !explicit.disabled) return explicit;

  const buttons = [...scope.querySelectorAll('button, input[type="button"], a[role="button"], div[role="button"]')];
  for (const button of buttons) {
    if (button.disabled || !isVisible(button)) continue;
    const label = textOf(button) || button.getAttribute?.('value') || '';
    if (label && label.length <= 20 && SUBMIT_BUTTON_RE.test(label)) return button;
  }
  return null;
}

/**
 * Submits the form the field belongs to.
 * Only ever called when the user has explicitly switched auto-submit on: it is
 * the one irreversible action in this extension.
 */
export function submitFor(el) {
  const button = findSubmitButton(el);
  if (button) {
    button.click();
    return true;
  }
  const form = el.closest?.('form');
  if (form) {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
    return true;
  }
  return false;
}
