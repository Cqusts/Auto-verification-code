#!/usr/bin/env node
/**
 * Downloads the local OCR engine (Tesseract.js + wasm core + traineddata) into
 * extension/vendor/tesseract/.
 *
 * The extension ships these files so that OCR runs entirely offline: Manifest V3
 * forbids loading remote code, and we do not want CAPTCHA images leaving the machine.
 *
 * Usage:
 *   node scripts/fetch-vendor.mjs            # default assets (eng)
 *   node scripts/fetch-vendor.mjs --lang chi_sim --lang eng
 *   node scripts/fetch-vendor.mjs --no-simd  # also fetch the non-SIMD core fallback
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'extension', 'vendor', 'tesseract');

const TESSERACT_JS_VERSION = '5.1.1';
const TESSERACT_CORE_VERSION = '5.1.1';
// "fast" integer models: ~2 MB per language and plenty accurate for CAPTCHA-sized text.
const TESSDATA_BASE = 'https://tessdata.projectnaptha.com/4.0.0_fast';

const args = process.argv.slice(2);
const langs = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--lang' && args[i + 1]) langs.push(args[(i += 1)]);
}
if (langs.length === 0) langs.push('eng');
const wantNonSimd = args.includes('--no-simd');

async function download(url, dest) {
  process.stdout.write(`  ${path.basename(dest)} ... `);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const { size } = await stat(dest);
  process.stdout.write(`${(size / 1024 / 1024).toFixed(2)} MB\n`);
}

function run(cmd, cmdArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd, stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

/** npm pack + extract, so we never depend on a CDN staying online. */
async function fromNpm(spec, files, tmp) {
  await run('npm', ['pack', spec, '--silent'], tmp);
  const tgz = (await readdir(tmp)).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no tarball for ${spec}`);
  const dir = path.join(tmp, 'x');
  await mkdir(dir, { recursive: true });
  await run('tar', ['xzf', path.join(tmp, tgz), '-C', dir], tmp);
  for (const [from, to] of files) {
    const src = path.join(dir, 'package', from);
    const dst = path.join(OUT, to);
    await pipeline(
      (await import('node:fs')).createReadStream(src),
      createWriteStream(dst),
    );
    const { size } = await stat(dst);
    console.log(`  ${to} ... ${(size / 1024 / 1024).toFixed(2)} MB`);
  }
  await rm(path.join(tmp, tgz), { force: true });
  await rm(dir, { recursive: true, force: true });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const tmp = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'avc-vendor-'));
  try {
    console.log(`tesseract.js@${TESSERACT_JS_VERSION}`);
    await fromNpm(`tesseract.js@${TESSERACT_JS_VERSION}`, [
      ['dist/tesseract.min.js', 'tesseract.min.js'],
      ['dist/worker.min.js', 'worker.min.js'],
    ], tmp);

    console.log(`tesseract.js-core@${TESSERACT_CORE_VERSION}`);
    const coreFiles = [['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js']];
    if (wantNonSimd) coreFiles.push(['tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']);
    await fromNpm(`tesseract.js-core@${TESSERACT_CORE_VERSION}`, coreFiles, tmp);

    console.log(`traineddata (${TESSDATA_BASE})`);
    for (const lang of langs) {
      await download(`${TESSDATA_BASE}/${lang}.traineddata.gz`, path.join(OUT, `${lang}.traineddata.gz`));
    }
    console.log(`\nDone -> ${path.relative(ROOT, OUT)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nfetch-vendor failed: ${err.message}`);
  process.exitCode = 1;
});
