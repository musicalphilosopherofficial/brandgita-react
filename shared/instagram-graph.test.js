// The Graph API version lives in ONE module; nothing else may pin its own.
// Run: node --test shared/instagram-graph.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IG_GRAPH_VERSION, IG_GRAPH_BASE } from './instagram-graph.js';

const ROOT = new URL('../', import.meta.url).pathname;
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
    return /\.js$/.test(e.name) && !/\.test\.js$/.test(e.name) ? [p] : [];
  });
}

test('the version is a vN.0 string and the base is built from it', () => {
  assert.match(IG_GRAPH_VERSION, /^v\d+\.0$/);
  assert.equal(IG_GRAPH_BASE, `https://graph.instagram.com/${IG_GRAPH_VERSION}`);
});

test('no source file hardcodes graph.instagram.com/vNN — they all import the shared constant', () => {
  const offenders = ['functions', 'cron-worker', 'shared'].flatMap((d) => sources(path.join(ROOT, d)))
    .filter((f) => /graph\.instagram\.com\/v\d/.test(fs.readFileSync(f, 'utf8')) && !f.endsWith('instagram-graph.js'));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});
