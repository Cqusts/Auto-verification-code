#!/usr/bin/env node
/**
 * Prints the CHANGELOG section for one version, for use as a release body.
 *
 *   node scripts/release-notes.mjs 1.0.0
 *   node scripts/release-notes.mjs v1.0.0 > notes.md
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] || '').replace(/^v/, '');

if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}

const changelog = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const lines = changelog.split('\n');

// Section runs from its own "## [x.y.z]" heading to the next "## " heading.
const start = lines.findIndex((l) => new RegExp(`^##\\s*\\[?${version.replace(/\./g, '\\.')}\\]?`).test(l));
if (start === -1) {
  console.error(`no CHANGELOG section for ${version}`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex((l) => /^##\s/.test(l));
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();

console.log(body);
