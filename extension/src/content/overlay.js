import { throttle } from '../common/util.js';
import { isVisible } from './dom-utils.js';

/**
 * A small status chip pinned next to the field we are working on.
 * Kept deliberately tiny and dismissible — it sits on top of someone's login page.
 */
export class Chip {
  constructor() {
    this.el = null;
    this.anchor = null;
    this.dismissed = false;
    this.hideTimer = null;
    this.reposition = throttle(() => this.place(), 60);
  }

  ensure() {
    if (this.el) return this.el;
    const chip = document.createElement('div');
    chip.className = 'avc-chip';
    chip.hidden = true;
    chip.innerHTML =
      '<span class="avc-chip__dot"></span>' +
      '<span class="avc-chip__text"></span>' +
      '<button class="avc-chip__btn" type="button" hidden></button>' +
      '<button class="avc-chip__close" type="button" title="hide">×</button>';
    chip.querySelector('.avc-chip__close').addEventListener('click', () => {
      this.dismissed = true;
      this.hide();
    });
    // The page must never see our own clicks as form interaction.
    chip.addEventListener('mousedown', (e) => e.stopPropagation());
    (document.body || document.documentElement).appendChild(chip);
    this.el = chip;

    addEventListener('scroll', this.reposition, { passive: true, capture: true });
    addEventListener('resize', this.reposition, { passive: true });
    return chip;
  }

  /**
   * @param {object} options
   * @param {Element} options.anchor  field to sit next to
   * @param {'waiting'|'working'|'done'|'error'} options.state
   * @param {string} options.text
   * @param {{label:string, onClick:Function}|null} [options.action]
   * @param {number} [options.autoHideMs]
   */
  show({ anchor, state, text, action = null, autoHideMs = 0 }) {
    if (this.dismissed) return;
    const chip = this.ensure();
    this.anchor = anchor || this.anchor;
    chip.className = `avc-chip avc-chip--${state}`;
    chip.querySelector('.avc-chip__text').textContent = text;

    const button = chip.querySelector('.avc-chip__btn');
    button.hidden = !action;
    if (action) {
      button.textContent = action.label;
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        action.onClick();
      };
    } else {
      button.onclick = null;
    }

    chip.hidden = false;
    this.place();

    clearTimeout(this.hideTimer);
    if (autoHideMs > 0) this.hideTimer = setTimeout(() => this.hide(), autoHideMs);
  }

  place() {
    if (!this.el || this.el.hidden || !this.anchor?.isConnected) return;
    if (!isVisible(this.anchor)) {
      this.el.hidden = true;
      return;
    }
    const rect = this.anchor.getBoundingClientRect();
    const chipRect = this.el.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + chipRect.height > innerHeight - 4) top = Math.max(4, rect.top - chipRect.height - 6);
    let left = rect.left;
    if (left + chipRect.width > innerWidth - 8) left = Math.max(8, innerWidth - chipRect.width - 8);
    this.el.style.top = `${Math.round(top)}px`;
    this.el.style.left = `${Math.round(left)}px`;
  }

  hide() {
    clearTimeout(this.hideTimer);
    if (this.el) this.el.hidden = true;
  }

  destroy() {
    removeEventListener('scroll', this.reposition, { capture: true });
    removeEventListener('resize', this.reposition);
    this.el?.remove();
    this.el = null;
  }
}

/** Briefly rings a field we just filled, so the user sees what happened. */
export function flashField(el) {
  if (!el) return;
  el.classList.add('avc-field-hit');
  setTimeout(() => el.classList.remove('avc-field-hit'), 1600);
}
