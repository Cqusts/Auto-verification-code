import {
  OTP_STRONG_RE,
  CAPTCHA_STRONG_RE,
  CODE_AMBIGUOUS_RE,
  FIELD_BLOCK_RE,
  NOT_OTP_FIELD_RE,
  PHONE_FIELD_RE,
  PHONE_BLOCK_RE,
  SEND_CODE_BUTTON_RE,
  CAPTCHA_IMG_RE,
  CAPTCHA_IMG_SIZE,
} from '../common/patterns.js';
import {
  deepQueryAll,
  isVisible,
  isFillableTextInput,
  describeField,
  containerOf,
  textOf,
} from './dom-utils.js';
import { resolveSelector } from './picker.js';

const OTP_THRESHOLD = 55;
const CAPTCHA_THRESHOLD = 55;

/** All plausibly-fillable text inputs on the page, shadow DOM included. */
export function collectInputs() {
  return deepQueryAll('input')
    .filter(isFillableTextInput)
    .filter(isVisible);
}

function rectDistance(a, b) {
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const bx = b.left + b.width / 2;
  const by = b.top + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Distance to the nearest "get SMS code" button, or Infinity when there is none.
 * Proximity matters as much as the label: on a single-form page the button can be
 * hundreds of pixels away from an unrelated field.
 */
function sendCodeButtonDistance(input) {
  const scope = containerOf(input, 4);
  const inputRect = input.getBoundingClientRect();
  const clickable = scope.querySelectorAll('button, a, span[role="button"], div[role="button"], input[type="button"]');
  let best = Infinity;
  for (const el of clickable) {
    const label = textOf(el) || el.getAttribute?.('value') || '';
    if (!label || label.length > 24 || !SEND_CODE_BUTTON_RE.test(label)) continue;
    best = Math.min(best, rectDistance(inputRect, el.getBoundingClientRect()));
  }
  return best <= 320 ? best : Infinity;
}

/**
 * Could this input hold a short code at all? Used only to decide whether a
 * nearby "get code" button is enough on its own, so it stays conservative.
 */
function looksCodeShaped(input, hay) {
  if (NOT_OTP_FIELD_RE.test(hay)) return false;
  const maxLength = Number(input.getAttribute('maxlength')) || 0;
  if (maxLength >= 4 && maxLength <= 8) return true;
  if (/^(numeric|tel)$/.test(input.getAttribute('inputmode') || '')) return true;
  const type = (input.getAttribute('type') || 'text').toLowerCase();
  if (type === 'number' || type === 'tel') return true;
  // A narrow box on a login form is nearly always the code, not the account.
  return input.getBoundingClientRect().width <= 220;
}

function backgroundImageUrl(el) {
  const bg = getComputedStyle(el).backgroundImage;
  const match = /url\(["']?([^"')]+)["']?\)/.exec(bg || '');
  return match ? match[1] : null;
}

/**
 * Finds the CAPTCHA picture belonging to an input.
 * Scores every nearby image by name, size, aspect ratio and distance; anything
 * that scores too low is treated as an unrelated logo/avatar.
 */
export function findCaptchaImage(input) {
  const scope = containerOf(input, 5);
  const inputRect = input.getBoundingClientRect();
  const candidates = [];

  // getBoundingClientRect is far cheaper than getComputedStyle, so filter on
  // geometry first: on a page that wraps everything in one <form> this is the
  // difference between a handful of style reads and a few thousand.
  const nearby = (el) => {
    const rect = el.getBoundingClientRect();
    const { minWidth, maxWidth, minHeight, maxHeight } = CAPTCHA_IMG_SIZE;
    if (rect.width < minWidth || rect.width > maxWidth) return null;
    if (rect.height < minHeight || rect.height > maxHeight) return null;
    const distance = rectDistance(inputRect, rect);
    return distance > 520 ? null : { rect, distance };
  };

  const consider = (el, kind, geometry = null) => {
    const geo = geometry || nearby(el);
    if (!geo || !isVisible(el)) return;
    const { rect, distance } = geo;
    const { idealRatioMin, idealRatioMax } = CAPTCHA_IMG_SIZE;

    let score = 40;
    const hay = [
      el.getAttribute?.('alt'),
      el.getAttribute?.('title'),
      el.id,
      el.className,
      el.getAttribute?.('src'),
      el.parentElement?.className,
    ]
      .filter(Boolean)
      .join(' ');
    if (CAPTCHA_IMG_RE.test(hay)) score += 55;

    const ratio = rect.width / Math.max(1, rect.height);
    if (ratio >= idealRatioMin && ratio <= idealRatioMax) score += 20;
    // Same visual row as the input is the classic layout.
    if (Math.abs(rect.top - inputRect.top) < Math.max(24, inputRect.height)) score += 20;
    score -= Math.min(35, distance / 12);
    if (kind === 'canvas') score += 10;

    candidates.push({ el, kind, score, rect, distance });
  };

  scope.querySelectorAll('img').forEach((el) => consider(el, 'img'));
  scope.querySelectorAll('canvas').forEach((el) => consider(el, 'canvas'));
  // Some sites paint the CAPTCHA as a CSS background on a div/span/a.
  let examined = 0;
  for (const el of scope.querySelectorAll('div, span, a, i, button')) {
    if (examined > 400) break;
    if (el.childElementCount > 2) continue;
    const geo = nearby(el);
    if (!geo) continue;
    examined += 1;
    if (backgroundImageUrl(el)) consider(el, 'background', geo);
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best && best.score >= 60 ? best : null;
}

/**
 * Classifies one input.
 * @returns {{kind:'otp'|'captcha', score:number, image?:object}|null}
 */
export function classifyField(input) {
  const hay = describeField(input);
  if (!hay) return null;
  if (FIELD_BLOCK_RE.test(hay)) return null;

  const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
  if (autocomplete.includes('one-time-code')) {
    return { kind: 'otp', score: 150, reasons: ['autocomplete=one-time-code'] };
  }

  let otp = 0;
  let captcha = 0;
  const reasons = [];

  if (OTP_STRONG_RE.test(hay)) {
    otp += 80;
    reasons.push('name:sms');
  }
  if (CAPTCHA_STRONG_RE.test(hay)) {
    captcha += 80;
    reasons.push('name:captcha');
  }
  const ambiguous = CODE_AMBIGUOUS_RE.test(hay);
  if (ambiguous) {
    otp += 30;
    captcha += 30;
    reasons.push('name:code');
  }
  const buttonDistance = sendCodeButtonDistance(input);

  if (!otp && !captcha) {
    // Nothing in the markup names this field. A "获取验证码" button beside a
    // code-shaped box is still conclusive: no other control on a page looks
    // like that, and plenty of sites ship inputs called `input3`.
    if (buttonDistance === Infinity) return null;
    if (!looksCodeShaped(input, hay)) return null;
    const score = OTP_THRESHOLD + 15 - Math.min(20, buttonDistance / 16);
    return { kind: 'otp', score, reasons: [`send-code-button-only(${Math.round(buttonDistance)}px)`] };
  }

  const image = findCaptchaImage(input);
  if (image) {
    captcha += 70;
    reasons.push(`image:${image.kind}`);
  } else if (ambiguous) {
    // "验证码" is ambiguous only while an image CAPTCHA is still on the table.
    // With no picture anywhere near the field, that reading is dead — a CAPTCHA
    // box with no CAPTCHA in it is unfillable, and the code below discards it
    // anyway — so the label resolves to the SMS kind by elimination.
    //
    // Without this, `<input placeholder="请输入验证码">` with no id, no name and
    // no adjacent button scores 30 against a threshold of 55 and is dropped,
    // even though its placeholder says in plain words what it is.
    otp += 35;
    reasons.push('code-label-without-image');
  }
  if (buttonDistance !== Infinity) {
    // Closer to the button beats further away, so the phone field above the
    // code field never outranks it.
    otp += 55 - Math.min(20, buttonDistance / 16);
    reasons.push(`send-code-button(${Math.round(buttonDistance)}px)`);
  }
  if (NOT_OTP_FIELD_RE.test(hay)) {
    otp -= 60;
    reasons.push('name:phone-or-account');
  }

  const maxLength = Number(input.getAttribute('maxlength')) || 0;
  if (maxLength >= 4 && maxLength <= 8) {
    otp += 8;
    captcha += 8;
    reasons.push(`maxlength=${maxLength}`);
  }
  if ((input.getAttribute('inputmode') || '') === 'numeric') otp += 5;

  if (captcha >= otp && captcha >= CAPTCHA_THRESHOLD) {
    // A CAPTCHA field without a picture is not something we can solve.
    if (!image) return null;
    return { kind: 'captcha', score: captcha, image, reasons };
  }
  if (otp >= OTP_THRESHOLD) return { kind: 'otp', score: otp, reasons };
  return null;
}

/**
 * Inputs that should receive the user's own phone number.
 *
 * Order matters: code fields are excluded *before* the phone test, because
 * `手机验证码` matches the phone pattern too and is emphatically not a phone box.
 */
export function findPhoneFields() {
  return collectInputs().filter((input) => {
    const hay = describeField(input);
    if (!hay) return false;
    if (FIELD_BLOCK_RE.test(hay) || PHONE_BLOCK_RE.test(hay)) return false;
    if (OTP_STRONG_RE.test(hay) || CAPTCHA_STRONG_RE.test(hay) || CODE_AMBIGUOUS_RE.test(hay)) return false;

    const type = (input.getAttribute('type') || 'text').toLowerCase();
    // type="tel" is a declaration; nothing else needs to agree.
    if (type === 'tel') return true;
    return PHONE_FIELD_RE.test(hay);
  });
}

/**
 * Split one-time-code widgets: several single-character boxes in a row.
 * Returns the ordered group that `input` belongs to, or null.
 */
export function findDigitGroup(input) {
  if (Number(input.getAttribute('maxlength')) !== 1) return null;
  const parent = input.parentElement?.parentElement || input.parentElement;
  if (!parent) return null;
  const siblings = [...parent.querySelectorAll('input')].filter(
    (el) => isFillableTextInput(el) && Number(el.getAttribute('maxlength')) === 1 && isVisible(el),
  );
  if (siblings.length < 4 || siblings.length > 10) return null;
  // Must be laid out on roughly one line.
  const tops = siblings.map((el) => el.getBoundingClientRect().top);
  if (Math.max(...tops) - Math.min(...tops) > 24) return null;
  siblings.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return siblings;
}

/**
 * Full page scan.
 * @returns {{otp:{input:Element,group:Element[]|null,score:number}|null,
 *            captchas:{input:Element,image:object,score:number}[]}}
 */
export function scanPage({ otpOverride = '' } = {}) {
  // A field the user pointed at wins outright — they know better than any
  // heuristic, and they only had to do it because the heuristics missed.
  const picked = resolveSelector(otpOverride);
  const inputs = collectInputs();
  let otpBest = null;
  const captchas = [];

  for (const input of inputs) {
    // A lone single-char box only makes sense as part of a split OTP widget.
    const group = findDigitGroup(input);
    if (group) {
      if (group[0] !== input) continue;
      const owner = group.find((el) => classifyField(el)) || input;
      const cls = classifyField(owner) || { kind: 'otp', score: 60, reasons: ['digit-group'] };
      if (cls.kind === 'otp' && (!otpBest || cls.score > otpBest.score)) {
        otpBest = { input, group, score: cls.score, reasons: cls.reasons };
      }
      continue;
    }

    const cls = classifyField(input);
    if (!cls) continue;
    if (cls.kind === 'otp') {
      if (!otpBest || cls.score > otpBest.score) {
        otpBest = { input, group: null, score: cls.score, reasons: cls.reasons };
      }
    } else {
      captchas.push({ input, image: cls.image, score: cls.score, reasons: cls.reasons });
    }
  }

  if (picked) {
    const group = findDigitGroup(picked);
    otpBest = { input: group ? group[0] : picked, group, score: 1000, reasons: ['manual-override'] };
  }

  captchas.sort((a, b) => b.score - a.score);
  return { otp: otpBest, captchas };
}
