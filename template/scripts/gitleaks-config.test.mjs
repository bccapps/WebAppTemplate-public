/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Tests of gitleaks-config.mjs: the rendering from the secret-format registry, the project fragment, the refusal to
// overwrite a hand-written file, and — with a real gitleaks (skipped when absent) — that every registered format is
// caught by its rule while fake-marked values and placeholders pass. Every value is random and built at run time.
//
// Run: node --test scripts/gitleaks-config.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXIT_KEPT, GENERATED_MARKER, checkLocalFragment, fakeValueRegex, renderGitleaksConfig, rulesOf, writeGitleaksConfig,
} from './gitleaks-config.mjs';
import { loadSecretFormats } from './lib/secret-formats.mjs';
import { fakeSample, formatSamples, gitleaks, gitleaksAvailable, randomBody } from './lib/secret-scan-testkit.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gitleaks-config.mjs');
const registry = loadSecretFormats();
const NO_GITLEAKS = gitleaksAvailable() ? false : 'gitleaks not installed';

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitleaks-config-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('one exact rule per format, one per family of OAuth tokens, unique ids, deterministic output', () => {
  const rules = rulesOf(registry);
  const expected = registry.formats.length + registry.formats.filter((f) => f.oauth).length;
  assert.equal(rules.length, expected);
  assert.equal(new Set(rules.map((r) => r.id)).size, expected);
  for (const rule of rules) assert.match(rule.id, /^vx-[a-z0-9-]+$/);
  const text = renderGitleaksConfig(registry);
  assert.equal(text, renderGitleaksConfig(registry));
  assert.ok(text.startsWith(GENERATED_MARKER));
  assert.match(text, /\[extend\]\nuseDefault = true\n/);
  assert.equal((text.match(/^\[\[rules\]\]$/gm) ?? []).length, expected);
  assert.equal((text.match(/^\[\[allowlists\]\]$/gm) ?? []).length, 1);
});

test('the fake-value allowlist is anchored on a registered prefix and an explicit marker', () => {
  const regex = new RegExp(fakeValueRegex(registry));
  for (const format of registry.formats) {
    for (const marker of registry.fakeMarkers) {
      assert.ok(regex.test(`${format.prefix}${marker}0`), `${format.prefix}${marker}`);
      if (format.oauth) assert.ok(regex.test(`${format.prefix}at_${marker}0`));
    }
    assert.ok(!regex.test(`${format.prefix}${randomBody(registry, 'base62', 4).toLowerCase()}fake`));
    assert.ok(!regex.test(`x${format.prefix}FAKE`));
  }
});

test('the project fragment is appended verbatim; what the generated part owns is refused', () => {
  const local = '[[rules]]\nid = "app-extra"\nregex = \'\'\'APP_[0-9]{8}\'\'\'\n';
  const text = renderGitleaksConfig(registry, local);
  assert.ok(text.endsWith(`# ---- .gitleaks.local.toml (project rules, verbatim) ----\n${local}`));
  assert.deepEqual(checkLocalFragment(local), []);
  assert.equal(checkLocalFragment('title = "x"').length, 1);
  assert.equal(checkLocalFragment('[extend]\nuseDefault = true').length, 1);
  assert.equal(checkLocalFragment('[allowlist]\npaths = []').length, 1);
  assert.match(checkLocalFragment('[[rules]]\nid = "vx-mine"')[0], /reserved/);
});

test('writes, then keeps up to date, never overwrites a hand-written .gitleaks.toml', () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.equal(writeGitleaksConfig(dir, { registry }).status, 'written');
    assert.equal(writeGitleaksConfig(dir, { registry }).status, 'unchanged');
    writeFileSync(path.join(dir, '.gitleaks.local.toml'), '[[allowlists]]\nregexes = [\'\'\'^app_FAKE\'\'\']\n');
    assert.equal(writeGitleaksConfig(dir, { registry, check: true }).status, 'outdated');
    assert.equal(writeGitleaksConfig(dir, { registry }).status, 'written');
    assert.match(readFileSync(path.join(dir, '.gitleaks.toml'), 'utf8'), /\^app_FAKE/);
    writeFileSync(path.join(dir, '.gitleaks.local.toml'), 'title = "mine"\n');
    assert.equal(writeGitleaksConfig(dir, { registry }).status, 'invalid-local');

    const own = '# my own rules\n[extend]\nuseDefault = true\n';
    writeFileSync(path.join(dir, '.gitleaks.toml'), own);
    rmSync(path.join(dir, '.gitleaks.local.toml'));
    assert.equal(writeGitleaksConfig(dir, { registry }).status, 'kept');
    assert.equal(readFileSync(path.join(dir, '.gitleaks.toml'), 'utf8'), own);
  } finally { cleanup(); }
});

test('CLI: exit 0 when written or up to date, 3 for a kept hand-written file, 1 for --check on a stale file', () => {
  const { dir, cleanup } = tempDir();
  try {
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    assert.equal(run(dir).status, 0);
    assert.equal(run('--check', dir).status, 0);
    writeFileSync(path.join(dir, '.gitleaks.toml'), `${readFileSync(path.join(dir, '.gitleaks.toml'), 'utf8')}# edited\n`);
    assert.equal(run('--check', dir).status, 1);
    writeFileSync(path.join(dir, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
    const kept = run(dir);
    assert.equal(kept.status, EXIT_KEPT);
    assert.match(kept.stderr, /hand-written, kept as is.*\.gitleaks\.local\.toml/s);
    assert.equal(run('--bogus').status, 2);
  } finally { cleanup(); }
});

// --- with the real gitleaks -------------------------------------------------------------------------------------------

/** Scans `lines` (one per line of a file) with the generated config (+ `local`); returns the findings per line number. */
function scanLines(lines, local = null) {
  const { dir, cleanup } = tempDir();
  try {
    const config = path.join(dir, 'gitleaks.toml');
    writeFileSync(config, renderGitleaksConfig(registry, local));
    const src = path.join(dir, 'src');
    mkdirSync(src);
    writeFileSync(path.join(src, 'values.txt'), `${lines.join('\n')}\n`);
    const r = gitleaks(['dir', src, '--config', config, '--exit-code', '0']);
    assert.equal(r.status, 0, r.output);
    const byLine = new Map();
    for (const f of r.findings) byLine.set(f.line, [...(byLine.get(f.line) ?? []), f.rule]);
    return byLine;
  } finally { cleanup(); }
}

test('gitleaks: every format and every OAuth token is caught by its own rule, a key rule never fires on a token', { skip: NO_GITLEAKS }, () => {
  const samples = formatSamples(registry);
  const found = scanLines(samples.map((s) => `x ${s.value} y`));
  samples.forEach((sample, i) => {
    const rules = found.get(i + 1) ?? [];
    assert.ok(rules.includes(sample.rule), `${sample.rule} (${sample.kind}): ${rules.join(',') || 'nothing'}`);
    if (sample.kind === 'oauth' && sample.format.length !== undefined) assert.ok(!rules.includes(`vx-${sample.format.id}`), `${sample.rule}: key rule fired`);
  });
});

test('gitleaks: encoded and glued forms are caught (percent-encoded, JSON-escaped newline, after a word)', { skip: NO_GITLEAKS }, () => {
  const value = formatSamples(registry).find((s) => s.rule === 'vx-tradekong-mcp-token').value;
  const lines = [`url ?k=${value.replace('_', '%5F')}&x`, `hdr Bearer%20${value}`, `json "a\\n${value}"`, `glued MY_${value}`];
  const found = scanLines(lines);
  lines.forEach((_, i) => assert.ok((found.get(i + 1) ?? []).includes('vx-tradekong-mcp-token'), lines[i].slice(0, 6)));
});

test('gitleaks: an AgentHub key inside an identifier is ignored; after a quote, a space or an escaped newline it is caught', { skip: NO_GITLEAKS }, () => {
  const key = () => `ac_live_${randomBody(registry, 'base62', 32)}`;
  const lines = [`id my_${key()}x`, `id x${key()}`, `k '${key()}'`, `json "a\\n${key()}"`, `env TOKEN=${key()}`];
  const found = scanLines(lines);
  const hit = (i) => (found.get(i + 1) ?? []).includes('vx-agenthub-api-key');
  assert.deepEqual(lines.map((_, i) => hit(i)), [false, false, true, true, true]);
});

test('gitleaks: fake-marked values and placeholders pass, by value', { skip: NO_GITLEAKS }, () => {
  const lines = [];
  for (const format of registry.formats) {
    for (const marker of registry.fakeMarkers) lines.push(`fake ${fakeSample(registry, format, marker)} end`);
    if (format.oauth) lines.push(`fake ${format.prefix}at_FAKE${randomBody(registry, 'base64url', 39)} end`);
    if (format.minEntropy > 0) lines.push(`placeholder ${format.prefix}${'x'.repeat(format.length ?? 32)} end`);
  }
  const found = scanLines(lines);
  assert.deepEqual([...found.entries()].map(([line, rules]) => `${lines[line - 1].split(' ')[1].slice(0, 12)}: ${rules}`), []);
});

test('gitleaks: a project fragment loads with the generated part and can target a generated rule', { skip: NO_GITLEAKS }, () => {
  const dummy = `tk_notakey${randomBody(registry, 'base64url', 36)}`;
  const local = [
    '[[allowlists]]',
    'description = "Dummy key values of the specs"',
    'targetRules = ["vx-tradekong-mcp-token"]',
    "regexes = ['''^tk_notakey''']",
  ].join('\n');
  assert.equal((scanLines([`k ${dummy}`]).get(1) ?? []).includes('vx-tradekong-mcp-token'), true);
  assert.equal(scanLines([`k ${dummy}`], local).size, 0);
});

test('the generated config of this repository is up to date (CI gate of vx-public)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (!existsSync(path.join(root, '.gitleaks.toml')) || !existsSync(path.join(root, 'nest/common/validation/secret-formats.json'))) return;
  assert.equal(writeGitleaksConfig(root, { registry, check: true }).status, 'unchanged', 'run: node template/scripts/gitleaks-config.mjs .');
});
