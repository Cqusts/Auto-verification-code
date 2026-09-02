#!/usr/bin/env node
/**
 * Static sanity checks that do not need a browser:
 *  - every .js file parses (ESM for modules, script for content scripts)
 *  - every .json file parses
 *  - manifest paths all exist
 *  - no stray imports of files that are missing
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

let errors = 0;
const fail = (msg) => {
  errors += 1;
  console.error(`  ✗ ${msg}`);
};

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      await walk(full, out);
    } else out.push(full);
  }
  return out;
}

function parseModule(source, filename) {
  // SourceTextModule parses without executing, which is exactly what we want.
  new vm.SourceTextModule(source, { identifier: filename });
}

async function main() {
  const files = await walk(EXT);

  console.log('parsing JavaScript');
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    const src = await readFile(file, 'utf8');
    const rel = path.relative(ROOT, file);
    try {
      parseModule(src, rel);
    } catch (err) {
      fail(`${rel}: ${err.message}`);
    }
  }

  console.log('parsing JSON');
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const rel = path.relative(ROOT, file);
    try {
      JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      fail(`${rel}: ${err.message}`);
    }
  }

  console.log('resolving relative imports');
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    const src = await readFile(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const m of src.matchAll(/(?:^|[\s;])(?:import|export)[^'"`]*?from\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      if (!existsSync(target)) fail(`${rel}: import not found -> ${m[1]}`);
    }
  }

  console.log('checking manifest references');
  const manifest = JSON.parse(await readFile(path.join(EXT, 'manifest.json'), 'utf8'));
  const refs = new Set();
  const collect = (value) => {
    if (typeof value === 'string') {
      if (/\.(js|css|html|png|json)$/i.test(value) && !value.includes('*')) refs.add(value);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(manifest);
  for (const ref of refs) {
    if (!existsSync(path.join(EXT, ref))) fail(`manifest references missing file: ${ref}`);
  }

  console.log('checking vendored OCR assets');
  const vendor = [
    'vendor/tesseract/tesseract.min.js',
    'vendor/tesseract/worker.min.js',
    'vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
    'vendor/tesseract/eng.traineddata.gz',
  ];
  for (const v of vendor) {
    const full = path.join(EXT, v);
    if (!existsSync(full)) fail(`missing ${v} — run: npm run vendor`);
    else {
      const { size } = await stat(full);
      if (size < 1024) fail(`${v} looks truncated (${size} bytes)`);
    }
  }

  console.log(errors === 0 ? '\nall checks passed' : `\n${errors} problem(s) found`);
  process.exitCode = errors ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
