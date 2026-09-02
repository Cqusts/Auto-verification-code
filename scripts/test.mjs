#!/usr/bin/env node
/** Runs every check in order; `--browser` adds the (slow) real-Chromium pass. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withBrowser = process.argv.includes('--browser');

const suites = [
  ['static checks', ['--experimental-vm-modules', 'scripts/check.mjs']],
  ['sms parser', ['scripts/test-extract.mjs']],
  ['bridge payloads', ['scripts/test-bridge-parse.mjs']],
  ['injection predicates', ['scripts/test-inject.mjs']],
  ['bridge server', ['scripts/test-bridge.mjs']],
  ...(withBrowser ? [['browser end-to-end', ['scripts/test-browser.mjs']]] : []),
];

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let failed = 0;
for (const [name, args] of suites) {
  console.log(`\n=== ${name} ===`);
  const code = await run(args);
  if (code !== 0) failed += 1;
}

console.log(failed ? `\n${failed} suite(s) failed` : '\nall suites passed');
process.exitCode = failed ? 1 : 0;
