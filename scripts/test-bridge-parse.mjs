#!/usr/bin/env node
/** extractMessages must cope with whatever shape a forwarder app sends. */
import { extractMessages } from '../extension/src/offscreen/bridge-client.js';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
};
const texts = (payload, path) => extractMessages(payload, path).map((m) => m.text);

check('bare string', texts('code 123456')[0] === 'code 123456');
check('json string', texts('{"text":"code 123456"}')[0] === 'code 123456');
check('object .text', texts({ text: 'a' })[0] === 'a');
check('object .content', texts({ content: 'b' })[0] === 'b');
check('object .body', texts({ body: 'c' })[0] === 'c');
check('bridge shape', texts({ id: '1', text: 'hello', receivedAt: 1 })[0] === 'hello');
check('array of objects', texts([{ text: 'x' }, { text: 'y' }]).join(',') === 'x,y');
check('wrapped in .messages', texts({ messages: [{ text: 'm1' }, { text: 'm2' }] }).join(',') === 'm1,m2');
check('wrapped in .data', texts({ data: [{ body: 'd1' }] })[0] === 'd1');
check('explicit responsePath', texts({ result: { list: [{ msg: 'p' }] } }, 'result.list')[0] === 'p');
check('direct code field', texts({ code: '4821' })[0] === '4821');
check('ignores empty', extractMessages({ text: '   ' }).length === 0);
check('ignores unrelated object', extractMessages({ status: 'ok', count: 3 }).length === 0);
check('dedupe key uses id', extractMessages({ id: 'a', text: 't' })[0].id === 'a');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
