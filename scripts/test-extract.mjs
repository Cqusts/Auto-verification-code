#!/usr/bin/env node
/** Regression corpus for the SMS code parser. Run: node scripts/test-extract.mjs */
import { extractCode, extractCodes, sanitizeOcrText, looksLikeVerificationSms } from '../extension/src/common/code-extract.js';

const cases = [
  ['【某某科技】您的验证码是 123456，5分钟内有效，请勿泄露给他人。', '123456'],
  ['【淘宝网】验证码：825193，您正在登录，请勿告知他人。', '825193'],
  ['尊敬的用户，您的动态密码为 4821，有效期10分钟。', '4821'],
  ['Your verification code is 738291. It expires in 10 minutes.', '738291'],
  ['G-459182 is your Google verification code.', '459182'],
  ['[Twitter] Use the code 902133 to log in.', '902133'],
  ['Your one-time passcode: 8412', '8412'],
  ['验证码 4 8 6 2 已发送', null],
  ['【京东】您的订单 20250901123 已发货，验证码 5566 用于签收。', '5566'],
  ['您尾号1234的银行卡消费300元，余额5000元。', null],
  ['【平台】校验码：７８９０１２，请勿转发。', '789012'],
  ['Hi, meeting at 2026 in room 1408. See notes at https://x.com/a/9931882', null],
  ['您好，手机号13800138000的短信验证码为 246810，15分钟内有效', '246810'],
  ['【某App】您正在重置密码，验证码 3721，请勿泄露。', '3721'],
  ['Code: 12345678 — do not share.', '12345678'],
  ['您的快递单号 7788990011 已签收，感谢使用。', null],
];

let pass = 0;
let fail = 0;
for (const [text, expected] of cases) {
  const got = extractCode(text);
  const ok = got === expected;
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL  ${JSON.stringify(text)}\n      expected=${expected} got=${got}`);
    console.log('      candidates:', JSON.stringify(extractCodes(text).slice(0, 3)));
  }
}

// sanitizeOcrText
const san = [
  [['a1 b2\nc3', { charset: '0123456789' }], '123'],
  [['HELLO', { charset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', expectedLength: 4 }], 'HELL'],
  [['  7g4k ', {}], '7g4k'],
];
for (const [[raw, opts], expected] of san) {
  const got = sanitizeOcrText(raw, opts);
  if (got === expected) pass += 1;
  else { fail += 1; console.log(`FAIL sanitizeOcrText(${JSON.stringify(raw)}) expected=${expected} got=${got}`); }
}

if (looksLikeVerificationSms('您的验证码是123456')) pass += 1; else { fail += 1; console.log('FAIL looksLikeVerificationSms zh'); }
if (!looksLikeVerificationSms('明天下午三点开会')) pass += 1; else { fail += 1; console.log('FAIL looksLikeVerificationSms negative'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
