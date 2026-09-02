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

/** GitHub's heading-anchor rules, close enough for CJK headings too. */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

async function markdownFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'vendor'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await markdownFiles(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Relative links and images in the docs must actually resolve. */
async function checkMarkdownLinks() {
  const files = await markdownFiles(ROOT);
  const anchorsOf = new Map();

  for (const file of files) {
    const src = await readFile(file, 'utf8');
    anchorsOf.set(
      file,
      new Set([...src.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slugify(m[1]))),
    );
  }

  for (const file of files) {
    const src = await readFile(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const targets = [
      ...[...src.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]),
      ...[...src.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ];

    for (const target of targets) {
      if (/^(https?:|mailto:|data:)/i.test(target)) continue;

      const [filePart, anchor] = target.split('#');
      if (!filePart) {
        // Same-document anchor.
        if (anchor && !anchorsOf.get(file).has(anchor)) fail(`${rel}: no heading for anchor #${anchor}`);
        continue;
      }

      const resolved = path.resolve(path.dirname(file), filePart);
      if (!existsSync(resolved)) {
        fail(`${rel}: link target not found -> ${target}`);
        continue;
      }
      if (anchor && resolved.endsWith('.md')) {
        const known = anchorsOf.get(resolved);
        if (known && !known.has(anchor)) fail(`${rel}: no heading for ${filePart}#${anchor}`);
      }
    }
  }
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

  console.log('checking version consistency');
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const manifestVersion = JSON.parse(await readFile(path.join(EXT, 'manifest.json'), 'utf8')).version;
  // The release workflow packages extension/ and names the artifact after this
  // version, so a drift between the two would ship a mislabelled build.
  if (pkg.version !== manifestVersion) {
    fail(`package.json version ${pkg.version} != manifest.json version ${manifestVersion}`);
  }
  const changelog = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (!new RegExp(`^##\\s*\\[?${manifestVersion.replace(/\./g, '\\.')}\\]?`, 'm').test(changelog)) {
    fail(`CHANGELOG.md has no section for ${manifestVersion}`);
  }

  console.log('checking documentation links');
  await checkMarkdownLinks();

  console.log('checking launcher scripts');
  for (const [name, mustContain] of [
    ['start-bridge.cmd', ['cd /d "%~dp0"', 'bridge\\server.mjs', 'pause']],
    ['start-bridge.sh', ['BASH_SOURCE', 'bridge/server.mjs']],
    ['create-shortcut.cmd', ['cd /d "%~dp0"', 'make-shortcut.mjs', 'pause']],
  ]) {
    const full = path.join(ROOT, name);
    if (!existsSync(full)) {
      fail(`missing launcher ${name}`);
      continue;
    }
    const src = await readFile(full, 'utf8');
    for (const needle of mustContain) {
      if (!src.includes(needle)) fail(`${name}: expected to contain ${JSON.stringify(needle)}`);
    }
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
