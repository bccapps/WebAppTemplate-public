/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMOTE_COMMANDS, composeProjectName, parseEnvFile, remoteLogDir, resolveTargets, selectFiles, sshEnvironment, sshFailureReason } from './fetch-preprod-validation-logs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'fetch-preprod-validation-logs.mjs');
const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const HOST = 'pp-host-7f3a.example.test';
const USER = 'deployer7f3a';
const PROJECT = 'demo7f3a';

/** Fake `ssh`: records its argv, never connects, answers the allow-listed commands from canned data. */
const FAKE_SSH = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
// Configuration from a file next to the stub: the real script gives ssh a minimal environment (PATH, HOME, USER...).
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'ssh-config.json'), 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(cfg.log, JSON.stringify(argv) + '\\n');
fs.appendFileSync(cfg.log + '.env', JSON.stringify(Object.keys(process.env).sort()) + '\\n');
const mode = cfg.mode;
if (mode === 'hostkey') { process.stderr.write('Host key verification failed for ${HOST}.\\n'); process.exit(255); }
if (mode === 'denied') { process.stderr.write('${USER}@${HOST}: Permission denied (publickey).\\n'); process.exit(255); }
const command = argv[argv.length - 1];
const project = '${PROJECT}-back-pp-host-7f3a-example-test';
if (command.startsWith('docker ps')) {
  process.stdout.write([project + '-back-1|back', project + '-back-worker-1|back-worker', 'evil;rm|back', 'pg|db'].join('\\n') + '\\n');
} else if (command.includes(' ls -1 ')) {
  process.stdout.write(['back-${day(0)}.log', '.env', 'validation-${day(0)}.jsonl', 'validation-${day(1)}.jsonl', 'validation-2020-01-01.jsonl', 'validation-../../x.jsonl'].join('\\n') + '\\n');
} else if (command.includes(' tail -c ')) {
  const bytes = Number(command.split(' tail -c ')[1].split(' ')[0]);
  const content = '{"partial":' + '\\n' + '{"v":1,"check":"demo.a","outcome":"ok"}\\n';
  process.stdout.write(cfg.big ? content.slice(-bytes).padStart(bytes, 'x') : content.slice(content.indexOf('\\n') + 1));
} else { process.exit(1); }
`;

function setup({ env = {}, mode = 'ok', big = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'vfetch-'));
  const bin = path.join(root, 'fakebin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'ssh'), FAKE_SSH);
  chmodSync(path.join(bin, 'ssh'), 0o755);
  const key = path.join(root, 'id_test');
  writeFileSync(key, 'not a key');
  const secret = randomBytes(12).toString('hex');
  const values = { PROJECT_NAME: PROJECT, BACK_HOSTS: `${USER}@${HOST}`, REMOTE_SSH_PORT: '2222', SSH_KEY_FILE: key, DB_PASSWORD: secret, ...env };
  mkdirSync(path.join(root, 'back'));
  writeFileSync(path.join(root, 'back', '.env.preprod'), Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  const log = path.join(root, 'ssh-calls.jsonl');
  writeFileSync(path.join(bin, 'ssh-config.json'), JSON.stringify({ log, mode, big }));
  const runEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CANARY_SECRET: 'never-passed-to-ssh' };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: runEnv });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const envKeys = () => readFileSync(`${log}.env`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { root, key, secret, run, calls, envKeys };
}

const SSH_OPTIONS = (key) => [
  '-T', '-p', '2222', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10',
  '-o', 'ServerAliveCountMax=3', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
  '-o', 'LogLevel=ERROR', '-i', key, '-o', 'IdentitiesOnly=yes', '--', `${USER}@${HOST}`,
];
const ALLOWED = [
  /^docker ps --format '\{\{\.Names\}\}\|\{\{\.Label "com\.docker\.compose\.service"\}\}' --filter 'label=com\.docker\.compose\.project=[a-z0-9_-]+'$/,
  /^docker exec '[A-Za-z0-9_.-]+' ls -1 -- '\/[A-Za-z0-9._/-]+'$/,
  /^docker exec '[A-Za-z0-9_.-]+' tail -c [1-9]\d* -- '\/[A-Za-z0-9._/-]+\/validation-\d{4}-\d{2}-\d{2}\.jsonl'$/,
];

test('copies the recent validation files read-only, through the allow-listed commands only', () => {
  const { root, key, secret, run, calls, envKeys } = setup();
  const res = run('--since', '7d');
  assert.equal(res.status, 0, res.stderr);
  const all = calls();
  for (const argv of all) {
    assert.deepEqual(argv.slice(0, -1), SSH_OPTIONS(key));
    assert.ok(ALLOWED.some((pattern) => pattern.test(argv.at(-1))), `command off the allow-list: ${argv.at(-1)}`);
    assert.ok(!argv.join(' ').includes(secret) && !/\.env|back-\d{4}-|\.\./.test(argv.at(-1)));
  }
  const project = composeProjectName(PROJECT, HOST);
  assert.equal(all[0].at(-1), `docker ps --format '{{.Names}}|{{.Label "com.docker.compose.service"}}' --filter 'label=com.docker.compose.project=${project}'`);
  assert.equal(all[1].at(-1), `docker exec '${project}-back-1' ls -1 -- '/app/logs'`);
  assert.equal(all[2].at(-1), `docker exec '${project}-back-1' tail -c 20971520 -- '/app/logs/validation-${day(0)}.jsonl'`);
  assert.equal(all.length, 7, 'docker ps + 2 containers × (ls + 2 files); evil;rm and pg skipped, old and odd names skipped');
  const out = path.join(root, '.validation-cache', 'preprod', 'host1');
  const file = path.join(out, 'back-1', `validation-${day(1)}.jsonl`);
  assert.equal(readFileSync(file, 'utf8'), '{"v":1,"check":"demo.a","outcome":"ok"}\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(out, 'back-worker-1')).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(root, '.validation-cache')).mode & 0o777, 0o700);
  assert.equal(readFileSync(path.join(root, '.validation-cache', '.gitignore'), 'utf8'), '*\n');
  for (const output of [res.stdout, res.stderr]) for (const value of [HOST, USER, key, secret, PROJECT]) assert.ok(!output.includes(value));
  for (const keys of envKeys()) assert.ok(keys.every((k) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING'].includes(k)), keys.join(','));
  assert.deepEqual(readdirSync(path.join(root, '.validation-cache')).sort(), ['.gitignore', 'preprod']);
  rmSync(root, { recursive: true });
});

test('a failed fetch leaves the previous copy untouched (atomic replacement); a symlinked cache is refused', () => {
  const { root, run } = setup();
  assert.equal(run().status, 0);
  const before = readFileSync(path.join(root, '.validation-cache', 'preprod', 'host1', 'back-1', `validation-${day(0)}.jsonl`), 'utf8');
  const { root: other, run: runDenied } = setup({ mode: 'denied' });
  rmSync(path.join(other, '.validation-cache'), { recursive: true, force: true });
  cpSync(path.join(root, '.validation-cache'), path.join(other, '.validation-cache'), { recursive: true });
  assert.equal(runDenied().status, 3);
  assert.equal(readFileSync(path.join(other, '.validation-cache', 'preprod', 'host1', 'back-1', `validation-${day(0)}.jsonl`), 'utf8'), before);
  assert.deepEqual(readdirSync(path.join(other, '.validation-cache')).sort(), ['.gitignore', 'preprod']);
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'vfetch-target-'));
  rmSync(path.join(root, '.validation-cache'), { recursive: true });
  symlinkSync(elsewhere, path.join(root, '.validation-cache'));
  assert.equal(run().status, 2);
  assert.deepEqual(readdirSync(elsewhere), []);
  for (const dir of [root, other, elsewhere]) rmSync(dir, { recursive: true, force: true });
});

test('drops the cut first line when a file is larger than --max-mb', () => {
  const { root, run } = setup({ big: true });
  assert.equal(run('--max-mb', '1').status, 0);
  const text = readFileSync(path.join(root, '.validation-cache', 'preprod', 'host1', 'back-1', `validation-${day(0)}.jsonl`), 'utf8');
  assert.equal(text, '{"v":1,"check":"demo.a","outcome":"ok"}\n');
  rmSync(root, { recursive: true });
});

test('refuses an unsafe value before any ssh call, without quoting it', () => {
  const bad = [
    { BACK_HOSTS: `${HOST};touch /tmp/pwned` }, { BACK_HOSTS: `$(id)@${HOST}` }, { BACK_HOSTS: `\`id\`.${HOST}` }, { BACK_HOSTS: `${HOST} -oProxyCommand=x` },
    { BACK_HOSTS: `-oProxyCommand=x` }, { PROJECT_NAME: "demo'x" }, { REMOTE_SSH_PORT: '22 -v' }, { LOG_DIR: '/app/../etc' }, { APP_DATA_DIR: '/app/../etc' }, { LOG_DIR: "/app/logs';id;'" },
    { APP_DATA_DIR: '/data dir' }, { BACK_HOSTS: '' }, { SSH_KEY_FILE: '/nonexistent/key' },
  ];
  for (const env of bad) {
    const { root, run, calls } = setup({ env });
    const res = run();
    assert.equal(res.status, 2, JSON.stringify(env));
    assert.deepEqual(calls(), []);
    for (const value of Object.values(env).filter(Boolean)) assert.ok(!res.stderr.includes(value), `value echoed: ${value}`);
    rmSync(root, { recursive: true });
  }
});

test('stops at once with a clear message when SSH is not ready (unknown host key, refused key)', () => {
  for (const [mode, message] of [['hostkey', /host key unknown or changed/], ['denied', /SSH key refused/]]) {
    const { root, run, calls } = setup({ mode });
    const res = run();
    assert.equal(res.status, 3);
    assert.match(res.stderr, message);
    assert.equal(calls().length, 1, 'no retry');
    assert.ok(!res.stderr.includes(HOST) && !res.stderr.includes(USER));
    rmSync(root, { recursive: true });
  }
});

test('missing env file, bad options → exit 2; --dry-run connects nowhere and shows no value', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vfetch-'));
  const res = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /back\/\.env\.preprod not found/);
  rmSync(root, { recursive: true });
  const { root: other, run, calls, key } = setup();
  assert.equal(run('--since', '90d').status, 2);
  assert.equal(run('--max-files', '500').status, 2);
  const dry = run('--dry-run');
  assert.equal(dry.status, 0);
  assert.deepEqual(calls(), []);
  for (const value of [HOST, USER, key, '2222']) assert.ok(!dry.stdout.includes(value));
  rmSync(other, { recursive: true });
});

test('pure helpers: env parsing, log dir, file selection, command builders refuse unsafe input', () => {
  assert.deepEqual(parseEnvFile('export REMOTE_HOST="h.example"\nDB_PASSWORD=x\n# REMOTE_USER=a\nREMOTE_USER=b # note\nREMOTE_USER=c\n'), { REMOTE_HOST: 'h.example', REMOTE_USER: 'c' });
  assert.deepEqual(parseEnvFile('\ufeffREMOTE_HOST=real.example\r\nTLS="-----BEGIN X\nREMOTE_HOST=other.example\n-----END X"\n'), { REMOTE_HOST: 'real.example' });
  assert.throws(() => parseEnvFile('TLS="never closed\nREMOTE_HOST=other.example\n'), (e) => e.exitCode === 2);
  assert.deepEqual(parseEnvFile('REMOTE_HOST="h.example" # preprod\nREMOTE_USER=\'deploy\' # note\n'), { REMOTE_HOST: 'h.example', REMOTE_USER: 'deploy' });
  assert.throws(() => REMOTE_COMMANDS.list('c1', '/app/../../etc'));
  assert.throws(() => REMOTE_COMMANDS.read('c1', '/app/../../etc', `validation-${day(0)}.jsonl`, 10));
  assert.deepEqual(Object.keys(sshEnvironment({ PATH: 'p', HOME: 'h', SSH_AUTH_SOCK: 's', DB_PASSWORD: 'x', AWS_SECRET_ACCESS_KEY: 'y' })), ['PATH', 'HOME', 'SSH_AUTH_SOCK']);
  assert.equal(remoteLogDir({}), '/app/logs');
  assert.equal(remoteLogDir({ LOG_DIR: 'shared/logs' }), '/app/shared/logs');
  assert.equal(remoteLogDir({ APP_DATA_DIR: '/app/shared' }), '/app/shared/logs');
  assert.deepEqual(selectFiles(`validation-${day(0)}.jsonl\nvalidation-2020-01-01.jsonl\nx.jsonl\n`, Date.now() - 86_400_000, 8), [`validation-${day(0)}.jsonl`]);
  assert.throws(() => REMOTE_COMMANDS.list("c'", '/app/logs'));
  assert.throws(() => REMOTE_COMMANDS.read('c', '/app/logs', '../.env', 10));
  assert.throws(() => REMOTE_COMMANDS.read('c', '/app/logs', `validation-${day(0)}.jsonl`, '1;id'));
  assert.equal(resolveTargets({ PROJECT_NAME: 'p', REMOTE_HOST: 'a.example, ops@b.example', REMOTE_USER: 'deploy' }).map((t) => `${t.user}@${t.host}`).join(','), 'deploy@a.example,ops@b.example');
  assert.match(sshFailureReason('ssh: Could not resolve hostname x'), /not resolvable/);
});
