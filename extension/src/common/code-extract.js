import { CODE_KEYWORDS, NEGATIVE_PREFIXES, NEGATIVE_SUFFIXES } from './patterns.js';

const FULLWIDTH_OFFSET = 0xfee0;

/** Normalises full-width digits/letters/punctuation that Chinese carriers love. */
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_OFFSET))
    .replace(/　/g, ' ')
    .replace(/[​-‏⁠﻿]/g, '');
}

/** URLs hide long ids that look exactly like codes; blank them before scanning. */
function blankUrls(text) {
  return text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, (m) => ' '.repeat(m.length));
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A unit only disqualifies a number when it sits *immediately* after it.
 * "123456，5分钟内有效" must not blame 分钟 on 123456.
 */
const UNIT_SUFFIX_RE = new RegExp(
  `^[\\s,，、。.:：;；)）]*(?:${NEGATIVE_SUFFIXES.map(escapeRe).join('|')})`,
  'i',
);

/**
 * Likewise a label only disqualifies the number it directly introduces.
 * "手机号13800138000的短信验证码为 246810" must not blame 手机号 on 246810.
 */
const NEG_PREFIX_RE = new RegExp(
  `(?:${NEGATIVE_PREFIXES.map(escapeRe).join('|')})[\\s:：#号No.()（）\\-–—]*$`,
  'i',
);

function windowBefore(text, index, size) {
  return text.slice(Math.max(0, index - size), index).toLowerCase();
}

function windowAfter(text, index, size) {
  return text.slice(index, index + size).toLowerCase();
}

/** Distance from the end of `hay` back to the nearest keyword; Infinity if absent. */
function nearestKeywordDistance(hay, keywords) {
  let best = Infinity;
  for (const kw of keywords) {
    const k = String(kw).toLowerCase();
    if (!k) continue;
    const idx = hay.lastIndexOf(k);
    if (idx === -1) continue;
    best = Math.min(best, hay.length - (idx + k.length));
  }
  return best;
}

function containsAny(hay, list) {
  return list.some((w) => hay.includes(String(w).toLowerCase()));
}

/**
 * Scores every code-shaped token in an SMS body and returns them best-first.
 *
 * @param {string} rawText          full SMS body
 * @param {object} [options]
 * @param {number} [options.minLength=4]
 * @param {number} [options.maxLength=8]
 * @param {'digits'|'alnum'} [options.charset='digits']
 * @param {string[]} [options.keywords]
 * @returns {{code:string, score:number, index:number, reasons:string[]}[]}
 */
export function extractCodes(rawText, options = {}) {
  const {
    minLength = 4,
    maxLength = 8,
    charset = 'digits',
    keywords = CODE_KEYWORDS,
  } = options;

  const min = Math.max(3, Math.min(minLength, maxLength));
  const max = Math.max(min, Math.min(maxLength, 12));

  const text = blankUrls(normalizeText(rawText));
  if (!text.trim()) return [];

  // Any run of the target alphabet; boundaries are checked afterwards so that a
  // 6-digit code inside an 11-digit phone number never leaks through.
  const tokenRe = charset === 'alnum' ? /[A-Za-z0-9]+/g : /\d+/g;
  const results = [];

  for (const match of text.matchAll(tokenRe)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (token.length < min || token.length > max) continue;
    if (charset === 'alnum' && !/\d/.test(token) && !/[A-Z]/.test(token)) continue;
    // Reject a run wedged inside a longer alphanumeric blob (ids, hashes).
    const prevChar = text[index - 1] || '';
    const nextChar = text[index + token.length] || '';
    if (/[A-Za-z0-9]/.test(prevChar) || /[A-Za-z0-9]/.test(nextChar)) continue;

    const before = windowBefore(text, index, 24);
    const after = windowAfter(text, index + token.length, 30);
    const immediateAfter = text.slice(index + token.length, index + token.length + 12);
    const reasons = [];
    let score = 0;

    const kwDistance = nearestKeywordDistance(before, keywords);
    if (kwDistance !== Infinity) {
      // "验证码：123456" (distance ~1) beats "验证码...其它 123456" (distance 20).
      const bonus = Math.round(Math.max(0, 60 - kwDistance * 2.5));
      score += bonus;
      reasons.push(`keyword-before(+${bonus})`);
    }
    if (containsAny(after, keywords)) {
      score += 30;
      reasons.push('keyword-after(+30)');
    }
    if (kwDistance === Infinity && containsAny(text.toLowerCase(), keywords)) {
      score += 10;
      reasons.push('keyword-in-message(+10)');
    }

    // Typical OTP lengths.
    const lengthBonus = { 4: 18, 5: 12, 6: 25, 8: 6 }[token.length] ?? 0;
    if (lengthBonus) {
      score += lengthBonus;
      reasons.push(`length(+${lengthBonus})`);
    }

    if (UNIT_SUFFIX_RE.test(immediateAfter)) {
      score -= 70;
      reasons.push('unit-suffix(-70)');
    }
    if (NEG_PREFIX_RE.test(before)) {
      score -= 70;
      reasons.push('negative-prefix(-70)');
    }
    // Chinese mobile number.
    if (/^1[3-9]\d{9}$/.test(token)) {
      score -= 90;
      reasons.push('phone-number(-90)');
    }
    // Year / date fragment.
    if (token.length === 4 && /^(19|20)\d{2}$/.test(token) && /[-/年.]/.test(nextChar + prevChar)) {
      score -= 45;
      reasons.push('date-like(-45)');
    }
    if (/[-/:.]/.test(prevChar) && /[-/:.]/.test(nextChar)) {
      score -= 25;
      reasons.push('inside-delimiters(-25)');
    }
    // A code is rarely the very last thing after a currency symbol.
    if (/[¥$€£]/.test(prevChar)) {
      score -= 60;
      reasons.push('currency(-60)');
    }
    // All-identical digits are far more often placeholders than codes.
    if (/^(\d)\1+$/.test(token)) {
      score -= 15;
      reasons.push('repdigit(-15)');
    }

    results.push({ code: token, score, index, reasons });
  }

  // Earlier tokens win ties: the code normally precedes the boilerplate.
  results.sort((a, b) => b.score - a.score || a.index - b.index);
  return results;
}

/**
 * Best code in the message, or null when nothing scores plausibly.
 * `minScore` guards against grabbing a random number out of a non-OTP SMS.
 */
export function extractCode(rawText, options = {}) {
  const { minScore = 20 } = options;
  const [best] = extractCodes(rawText, options);
  if (!best || best.score < minScore) return null;
  return best.code;
}

/** Cheap pre-filter for bridge messages, so unrelated SMS never reach the page. */
export function looksLikeVerificationSms(rawText, keywords = CODE_KEYWORDS) {
  const text = normalizeText(rawText).toLowerCase();
  return keywords.some((k) => text.includes(String(k).toLowerCase()));
}

/** Normalises OCR output to the configured alphabet and length. */
export function sanitizeOcrText(raw, { charset = '', expectedLength = 0 } = {}) {
  let out = normalizeText(raw).replace(/\s+/g, '');
  if (charset) {
    const allowed = new Set(charset.split(''));
    out = out.split('').filter((c) => allowed.has(c)).join('');
  }
  if (expectedLength > 0 && out.length > expectedLength) out = out.slice(0, expectedLength);
  return out;
}
