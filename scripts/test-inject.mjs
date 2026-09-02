#!/usr/bin/env node
/** Guards for the two predicates that decide whether we can reach a page. */
import { isNoReceiverError } from '../extension/src/background/inject.js';
import { isInjectableUrl } from '../extension/src/common/site-rules.js';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

// The exact strings Chrome/Edge produce when a tab has no content script.
check('detects "Receiving end does not exist"',
  isNoReceiverError('Could not establish connection. Receiving end does not exist.'));
check('detects the short form', isNoReceiverError('Receiving end does not exist.'));
check('detects the connection form', isNoReceiverError('Could not establish connection.'));
check('ignores the closed-port error',
  isNoReceiverError('The message port closed before a response was received.') === false);
check('ignores empty', isNoReceiverError('') === false);
check('ignores undefined', isNoReceiverError(undefined) === false);

check('http is injectable', isInjectableUrl('http://example.com/a'));
check('https is injectable', isInjectableUrl('https://example.com/a'));
check('file is injectable', isInjectableUrl('file:///tmp/a.html'));
check('edge:// is not', isInjectableUrl('edge://extensions/') === false);
check('chrome:// is not', isInjectableUrl('chrome://settings') === false);
check('extension pages are not', isInjectableUrl('chrome-extension://abc/popup.html') === false);
check('about:blank is not', isInjectableUrl('about:blank') === false);
check('undefined is not', isInjectableUrl(undefined) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
