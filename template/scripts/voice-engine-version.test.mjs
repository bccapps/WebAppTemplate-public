/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// VOICE_ENGINE_VERSION of deploy-full.sh (VOICE_ENGINE=on): unset / empty / `latest` resolves the latest published release of
// VOICE_ENGINE_REPO through the GitHub API, an explicit version pins the deploy as before, and anything unresolvable fails closed
// before the image is built. Offline: runs against the stub binaries of deploy-test-kit.mjs, with a stub `git credential fill`
// (a FAKE token) and a stub `curl` that stands for api.github.com. No real credential, no network.
//
// Also: the version recorded in .deploy/current.json and the uploaded .env, the engine image kept as `previous` and restored by the
// automatic and the manual rollback, no engine start for a back that does not serve, the registry-mode and front-only rules, pinned
// values validated, nothing secret in an xtrace, and the Dockerfile's download of a release tagged with or without `v`.
//
// Run: node --test scripts/voice-engine-version.test.mjs   (needs bash, python3 and jq)

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BACK_PROJECT, SCRIPTS_DIR, makeProject, write } from './deploy-test-kit.mjs';

const indexOfLine = (lines, re, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const FAKE_TOKEN = 'ghp_FAKEvoiceReleaseToken0123456789';
const ENGINE_ENV = `VOICE_ENGINE=on\nVOICE_ENGINE_TOKEN=FAKEshared-engine-secret\n`;

// git: `credential fill` answers password=$STUB_VOICE_CRED (nothing when unset), logged WITHOUT its stdin or answer.
const GIT_STUB = (real) => `#!/usr/bin/env bash
{ set +x; } 2>/dev/null
case "$*" in
  *"credential fill"*)
    echo "git $*" >> "$STUB_LOG"
    cat > /dev/null
    if [ -n "\${STUB_VOICE_CRED:-}" ]; then printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n' "$STUB_VOICE_CRED"; fi
    exit 0 ;;
esac
exec "${real}" "$@"
`;
// curl: stands for the GitHub API. Logs argv, keeps stdin (the curl config) and the environment in files, answers the body in
// $STUB_CURL_BODY then the --write-out line (\n + $STUB_CURL_CODE, default 200).
const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
case "$*" in *--config\\ -*) cat > "$STUB_STATE/curl_stdin" ;; *) cat > /dev/null ;; esac
env | grep -v "^STUB_" > "$STUB_STATE/curl_env"
[ -n "\${STUB_CURL_BODY:-}" ] && printf '%s' "$STUB_CURL_BODY"
printf '\\n%s' "\${STUB_CURL_CODE:-200}"
exit 0
`;
// docker: logs, for the voice-engine image build, the VOICE_ENGINE_VERSION compose would interpolate and whether the build secret is set.
// It also creates the image the build tags \`testapp_voice_engine:<version>\` (content engine-<version>) and logs the engine starts.
const docker = (real) => `#!/usr/bin/env bash
{ set +x; } 2>/dev/null
case "$*" in
  *" build "*voice-engine*)
    echo "voice-build version=\${VOICE_ENGINE_VERSION:-<unset>} secret=$([ -n "\${VOICE_ENGINE_RELEASE_TOKEN:-}" ] && echo set)" >> "$STUB_LOG"
    echo "engine-\${VOICE_ENGINE_VERSION:-dev}" > "$STUB_STATE/img_testapp_voice_engine_\${VOICE_ENGINE_VERSION:-dev}" ;;
  *" up "*voice-engine*) echo "voice-up version=\${VOICE_ENGINE_VERSION:-<unset>}" >> "$STUB_LOG" ;;
esac
exec "${real}" "$@"
`;

function voiceProject(extra = ENGINE_ENV, { registry = false, engine = 'sqlite' } = {}) {
  const p = makeProject({ engine, extraBackEnv: registry ? `${REGISTRY_ENV}\n${extra}` : extra });
  p.seedImage('testapp_back:latest', 'v1');
  p.seedVolume(`${BACK_PROJECT_VOLUME}`);
  const bin = path.join(p.root, '.stubs');
  for (const [name, wrap] of [['git', GIT_STUB], ['docker', docker]]) {
    renameSync(path.join(bin, name), path.join(bin, `${name}.real`));
    write(path.join(bin, name), wrap(path.join(bin, `${name}.real`)), 0o755);
  }
  write(path.join(bin, 'curl'), CURL_STUB, 0o755);
  return p;
}
const REGISTRY_ENV = 'DEPLOY_REGISTRY=registry.example.com\nDEPLOY_REGISTRY_PUSH=localhost:5000\nDEPLOY_BUILDER_HOST=builder@10.0.0.9';
const BACK_PROJECT_VOLUME = `${BACK_PROJECT}_sqlite_data`;

const release = (over = {}) => JSON.stringify({ tag_name: 'v1.4.2', draft: false, prerelease: false, assets: [], ...over });
const deploy = (p, env = {}) => p.run(['prod', '--no-update-common', '--target=back'], { STUB_VOICE_CRED: FAKE_TOKEN, STUB_CURL_BODY: release(), ...env });
const apiCalls = (p) => p.logLines().filter((l) => /^curl .*api\.github\.com/.test(l));
const voiceBuilds = (p) => p.logLines().filter((l) => /^voice-build /.test(l));
const voiceUps = (p) => p.logLines().filter((l) => /^voice-up /.test(l));
const stateJson = (p) => JSON.parse(p.logLines().filter((l) => l.startsWith('STATE_JSON: ')).pop().slice('STATE_JSON: '.length));
const uploadedEnv = (p) => readFileSync(path.join(p.state, 'uploaded_.env.remote'), 'utf8');

test('unset: resolves the latest release (leading v stripped), prints it, builds and tags that version', () => {
  const p = voiceProject();
  try {
    const r = deploy(p);
    assert.equal(r.status, 0, r.out);
    assert.match(strip(r.out), /resolved the latest release of svax974\/vx-voice-engine: 1\.4\.2/);
    assert.match(strip(r.out), /Building voice-engine image \(vx-voice-engine 1\.4\.2\)/);
    assert.deepEqual(voiceBuilds(p), ['voice-build version=1.4.2 secret=set']);
    const calls = apiCalls(p);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /https:\/\/api\.github\.com\/repos\/svax974\/vx-voice-engine\/releases\/latest$/);
    assert.match(calls[0], /--config - /);
  } finally { p.cleanup(); }
});

test('empty, `latest` and `LATEST` behave like unset; VOICE_ENGINE_REPO is honoured; a tag without v is kept', () => {
  for (const value of ['', 'latest', 'LATEST']) {
    const p = voiceProject(`${ENGINE_ENV}VOICE_ENGINE_VERSION=${value}\nVOICE_ENGINE_REPO=acme/other-engine\n`);
    try {
      const r = deploy(p, { STUB_CURL_BODY: release({ tag_name: '2.0.0-rc.1' }) });
      assert.equal(r.status, 0, `[${value}] ${r.out}`);
      assert.match(strip(r.out), /resolved the latest release of acme\/other-engine: 2\.0\.0-rc\.1/);
      assert.deepEqual(voiceBuilds(p), ['voice-build version=2.0.0-rc.1 secret=set']);
      assert.match(apiCalls(p)[0], /repos\/acme\/other-engine\/releases\/latest$/);
    } finally { p.cleanup(); }
  }
});

test('an explicit version pins the deploy exactly as before: no API call, that version is built', () => {
  const p = voiceProject(`${ENGINE_ENV}VOICE_ENGINE_VERSION=0.3.1\n`);
  try {
    const r = deploy(p);
    assert.equal(r.status, 0, r.out);
    assert.equal(apiCalls(p).length, 0);
    assert.match(strip(r.out), /VOICE_ENGINE_VERSION pinned to 0\.3\.1/);
    assert.deepEqual(voiceBuilds(p), ['voice-build version=0.3.1 secret=set']);
  } finally { p.cleanup(); }
});

test('VOICE_ENGINE=off never resolves anything, whatever VOICE_ENGINE_VERSION says', () => {
  const p = voiceProject('VOICE_ENGINE=off\nVOICE_ENGINE_VERSION=latest\n');
  try {
    const r = deploy(p);
    assert.equal(r.status, 0, r.out);
    assert.equal(apiCalls(p).length, 0);
    assert.equal(voiceBuilds(p).length, 0);
  } finally { p.cleanup(); }
});

test('the credential reaches curl only as a config on stdin: never in argv, the environment, the log or the output', () => {
  const p = voiceProject();
  try {
    const r = deploy(p);
    assert.equal(r.status, 0, r.out);
    const stdin = readFileSync(path.join(p.state, 'curl_stdin'), 'utf8');
    assert.equal(stdin, `header = "Authorization: Bearer ${FAKE_TOKEN}"\n`);
    assert.ok(!readFileSync(path.join(p.state, 'curl_env'), 'utf8').includes(FAKE_TOKEN), 'not in curl environment');
    assert.ok(!readFileSync(p.log, 'utf8').includes(FAKE_TOKEN), 'not in any logged argv');
    assert.ok(!r.out.includes(FAKE_TOKEN), 'not in the deploy output');
    assert.ok(!/Authorization|Bearer/i.test(apiCalls(p)[0]), 'no header in argv');
  } finally { p.cleanup(); }
});

test('a credential holding quotes or backslashes cannot break out of the curl config', () => {
  const p = voiceProject();
  try {
    const nasty = 'ab"c\\d" url = "https://evil.example/x';
    const r = deploy(p, { STUB_VOICE_CRED: nasty });
    assert.equal(r.status, 0, r.out);
    const stdin = readFileSync(path.join(p.state, 'curl_stdin'), 'utf8');
    assert.equal(stdin, 'header = "Authorization: Bearer ab\\"c\\\\d\\" url = \\"https://evil.example/x"\n');
    assert.equal(stdin.split('\n').filter(Boolean).length, 1, 'one config line');
  } finally { p.cleanup(); }
});

const FAIL_CASES = [
  ['no credential', { STUB_VOICE_CRED: '' }, /needs a git credential for github\.com\/svax974\/vx-voice-engine/],
  ['HTTP 404 (no published release)', { STUB_CURL_CODE: '404', STUB_CURL_BODY: '{"message":"Not Found"}' }, /no published .*release.*HTTP 404/],
  ['HTTP 401', { STUB_CURL_CODE: '401', STUB_CURL_BODY: '{"message":"Bad credentials"}' }, /refused the credential .*HTTP 401/],
  ['HTTP 403', { STUB_CURL_CODE: '403', STUB_CURL_BODY: '{}' }, /refused the credential .*HTTP 403/],
  ['HTTP 500', { STUB_CURL_CODE: '500', STUB_CURL_BODY: '{}' }, /could not query the latest release .*HTTP '500'/],
  ['unreachable (curl failure, no code)', { STUB_CURL_CODE: '000', STUB_CURL_BODY: '' }, /could not query the latest release .*HTTP '000'/],
  ['body that is not JSON', { STUB_CURL_BODY: '<html>oops</html>' }, /not usable/],
  ['a draft', { STUB_CURL_BODY: release({ draft: true }) }, /not usable/],
  ['a prerelease', { STUB_CURL_BODY: release({ prerelease: true }) }, /not usable/],
  ['draft/prerelease missing from the answer', { STUB_CURL_BODY: JSON.stringify({ tag_name: 'v1.0.0' }) }, /not usable/],
  ['no tag_name', { STUB_CURL_BODY: JSON.stringify({ draft: false, prerelease: false }) }, /not usable/],
  ['tag that is not semver-like', { STUB_CURL_BODY: release({ tag_name: 'nightly' }) }, /not usable/],
  ['tag with an injection attempt', { STUB_CURL_BODY: release({ tag_name: 'v1.0.0; touch /tmp/pwned' }) }, /not usable/],
  ['tag with a path', { STUB_CURL_BODY: release({ tag_name: 'v../../1.0.0' }) }, /not usable/],
  ['tag with a newline', { STUB_CURL_BODY: release({ tag_name: 'v1.0.0\nVOICE_ENGINE_TOKEN=x' }) }, /not usable/],
  ['tag with build metadata (not a valid image tag)', { STUB_CURL_BODY: release({ tag_name: 'v1.0.0+abc' }) }, /not usable/],
  ['overlong tag', { STUB_CURL_BODY: release({ tag_name: `v1.0.0-${'a'.repeat(80)}` }) }, /not usable/],
];
for (const [name, env, message] of FAIL_CASES) {
  test(`fails closed before anything is built: ${name}`, () => {
    const p = voiceProject();
    try {
      const r = deploy(p, env);
      assert.equal(r.status, 1, r.out);
      assert.match(strip(r.out), message);
      assert.equal(voiceBuilds(p).length, 0, 'no voice-engine build');
      assert.equal(p.logLines().filter((l) => /^docker .*compose .* build /.test(l)).length, 0, 'nothing built at all');
      assert.equal(p.image('testapp_back:latest'), 'v1', 'the running image is untouched');
      assert.ok(!existsSync('/tmp/pwned'));
      assert.ok(!r.out.includes(FAKE_TOKEN));
    } finally { p.cleanup(); }
  });
}

test('VOICE_ENGINE_TOKEN is still required, and checked before the API is queried', () => {
  const p = voiceProject('VOICE_ENGINE=on\n');
  try {
    const r = deploy(p);
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.out), /needs VOICE_ENGINE_TOKEN/);
    assert.equal(apiCalls(p).length, 0);
  } finally { p.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Record of the deployed engine version (M1)
// ---------------------------------------------------------------------------------------------------------------------------------

test('the resolved version is recorded: voiceEngineVersion in .deploy/current.json and VOICE_ENGINE_VERSION in the uploaded .env', () => {
  for (const envLine of ['', 'VOICE_ENGINE_VERSION=latest\n']) {
    const p = voiceProject(`${ENGINE_ENV}${envLine}`);
    try {
      const r = deploy(p);
      assert.equal(r.status, 0, r.out);
      assert.equal(stateJson(p).voiceEngineVersion, '1.4.2');
      const lines = uploadedEnv(p).split('\n').filter((l) => l.startsWith('VOICE_ENGINE_VERSION='));
      assert.deepEqual(lines, ['VOICE_ENGINE_VERSION=1.4.2'], `[${envLine.trim() || 'unset'}] one line, the resolved value`);
    } finally { p.cleanup(); }
  }
});

test('a pinned version is recorded the same way; VOICE_ENGINE=off records nothing', () => {
  let p = voiceProject(`${ENGINE_ENV}VOICE_ENGINE_VERSION=0.3.1\n`);
  try {
    assert.equal(deploy(p).status, 0);
    assert.equal(stateJson(p).voiceEngineVersion, '0.3.1');
    assert.match(uploadedEnv(p), /^VOICE_ENGINE_VERSION=0\.3\.1$/m);
  } finally { p.cleanup(); }
  p = voiceProject('VOICE_ENGINE=off\n');
  try {
    assert.equal(deploy(p).status, 0);
    assert.ok(!('voiceEngineVersion' in stateJson(p)));
    assert.ok(!/VOICE_ENGINE_VERSION/.test(uploadedEnv(p)));
  } finally { p.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Where the version is resolved (L1) and what a pin must look like (L3)
// ---------------------------------------------------------------------------------------------------------------------------------

test('registry mode: --deploy --tag without --build refuses an unpinned version, before any host is touched', () => {
  for (const v of ['', 'VOICE_ENGINE_VERSION=latest\n']) {
    const p = voiceProject(`${ENGINE_ENV}${v}`, { registry: true });
    try {
      const r = p.run(['prod', '--target=back', '--deploy', '--tag=v1.2.3'], { STUB_VOICE_CRED: FAKE_TOKEN, STUB_CURL_BODY: release() });
      assert.equal(r.status, 1, r.out);
      assert.match(strip(r.out), /cannot be deployed with --deploy --tag but without --build: pin VOICE_ENGINE_VERSION/);
      assert.equal(apiCalls(p).length, 0);
      assert.equal(p.logLines().filter((l) => /^(ssh|scp|docker) /.test(l)).length, 0, 'no host touched');
    } finally { p.cleanup(); }
  }
});

test('registry mode: --deploy --tag with a pinned version goes through; a full registry deploy (build + deploy) resolves; --build alone does not', () => {
  let p = voiceProject(`${ENGINE_ENV}VOICE_ENGINE_VERSION=0.3.1\n`, { registry: true });
  try {
    const r = p.run(['prod', '--target=back', '--deploy', '--tag=v1.2.3'], { STUB_VOICE_CRED: FAKE_TOKEN });
    assert.equal(r.status, 0, r.out);
    assert.equal(apiCalls(p).length, 0);
    assert.deepEqual(voiceBuilds(p), ['voice-build version=0.3.1 secret=set']);
  } finally { p.cleanup(); }
  p = voiceProject(ENGINE_ENV, { registry: true });
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_VOICE_CRED: FAKE_TOKEN, STUB_CURL_BODY: release() });
    assert.equal(r.status, 0, r.out);
    assert.equal(apiCalls(p).length, 1);
    assert.deepEqual(voiceBuilds(p), ['voice-build version=1.4.2 secret=set']);
  } finally { p.cleanup(); }
  p = voiceProject(ENGINE_ENV, { registry: true });
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back', '--build'], { STUB_VOICE_CRED: FAKE_TOKEN, STUB_CURL_BODY: release() });
    assert.equal(r.status, 0, r.out);
    assert.equal(apiCalls(p).length, 0, 'an image-only phase deploys no engine: nothing to resolve');
  } finally { p.cleanup(); }
});

test('a front-only deploy never queries the API, whatever VOICE_ENGINE_VERSION says', () => {
  const q = voiceProject();
  try {
    const r = q.run(['prod', '--no-update-common', '--target=front'], { STUB_VOICE_CRED: FAKE_TOKEN, STUB_CURL_BODY: release() });
    assert.equal(apiCalls(q).length, 0, r.out);
    assert.equal(voiceBuilds(q).length, 0);
  } finally { q.cleanup(); }
});

for (const bad of ['v1.2.3', '1.2', '1.0.0+build', '1.0.0; touch /tmp/pwned', '../1.0.0', 'nightly', '1.0.0-']) {
  test(`a pinned VOICE_ENGINE_VERSION that is not a release version is refused: ${JSON.stringify(bad)}`, () => {
    const p = voiceProject(`${ENGINE_ENV}VOICE_ENGINE_VERSION='${bad}'\n`);
    try {
      const r = deploy(p);
      assert.equal(r.status, 1, r.out);
      assert.match(strip(r.out), /VOICE_ENGINE_VERSION='.*' is not valid/);
      assert.equal(apiCalls(p).length, 0);
      assert.equal(voiceBuilds(p).length, 0);
      assert.equal(p.logLines().filter((l) => /^docker .*compose .* build /.test(l)).length, 0, 'nothing built');
    } finally { p.cleanup(); }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The engine image, `previous`, and the rollbacks (M2)
// ---------------------------------------------------------------------------------------------------------------------------------

test('deploy: the running engine image is kept as previous, the new build is tagged latest and the engine started from it', () => {
  const p = voiceProject();
  try {
    p.seedImage('testapp_voice_engine:latest', 'engine-old');
    const r = deploy(p);
    assert.equal(r.status, 0, r.out);
    assert.equal(p.image('testapp_voice_engine:previous'), 'engine-old');
    assert.equal(p.image('testapp_voice_engine:latest'), 'engine-1.4.2');
    assert.deepEqual(voiceUps(p), ['voice-up version=1.4.2']);
  } finally { p.cleanup(); }
});

test('deploy: a back that does not become healthy never starts the new engine; the automatic rollback puts the previous engine back', () => {
  const p = voiceProject();
  try {
    p.seedImage('testapp_voice_engine:latest', 'engine-old');
    const r = deploy(p, { STUB_BACK_HEALTH: 'bad' });
    assert.equal(r.status, 3, r.out);
    assert.match(strip(r.stdout), /^==> \[BACK:10\.0\.0\.1\] voice-engine rolled back$/m);
    assert.deepEqual(voiceUps(p), ['voice-up version=latest'], 'only the rollback starts an engine, from the restored latest');
    assert.equal(p.image('testapp_voice_engine:latest'), 'engine-old');
    const lines = p.logLines();
    assert.ok(indexOfLine(lines, /^voice-up /) > indexOfLine(lines, /^docker .* tag testapp_back:previous testapp_back:latest$/), 'after the back rollback');
  } finally { p.cleanup(); }
});

test('deploy: nothing to restore when this run kept no previous engine (first deploy with the engine): rollback leaves it alone', () => {
  const p = voiceProject();
  try {
    p.seedImage('testapp_voice_engine:previous', 'engine-ancient'); // an older deploy's: must NOT come back
    const r = deploy(p, { STUB_BACK_HEALTH: 'bad' });
    assert.equal(r.status, 3, r.out);
    assert.equal(voiceUps(p).length, 0);
    assert.equal(p.image('testapp_voice_engine:previous'), 'engine-ancient');
  } finally { p.cleanup(); }
});

test('deploy stopped before the switch (failed pre-switch dump): the engine image `latest` goes back to the running one', () => {
  const p = voiceProject(`${ENGINE_ENV}DB_SCHEMA_MODE=sync\n`, { engine: 'supabase' });
  try {
    p.seedImage('testapp_voice_engine:latest', 'engine-old');
    const r = deploy(p, { STUB_PGDUMP_FAIL: '1' });
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.out), /deploy stopped before the switch/);
    assert.equal(voiceBuilds(p).length, 1, 'the engine image had been built');
    assert.equal(p.image('testapp_voice_engine:latest'), 'engine-old');
    assert.equal(voiceUps(p).length, 0);
  } finally { p.cleanup(); }
});

test('manual rollback swaps the engine images like the back ones and restarts the engine from latest; twice rolls forward', () => {
  const p = voiceProject('VOICE_ENGINE=on\n');
  try {
    p.seedImage('testapp_back:previous', 'v0');
    p.seedImage('testapp_voice_engine:latest', 'engine-new');
    p.seedImage('testapp_voice_engine:previous', 'engine-old');
    let r = p.run(['rollback', 'prod', '--target=back']);
    assert.equal(r.status, 0, r.out);
    assert.equal(p.image('testapp_voice_engine:latest'), 'engine-old');
    assert.equal(p.image('testapp_voice_engine:previous'), 'engine-new');
    assert.equal(p.image('testapp_voice_engine:rollback-tmp'), null);
    assert.deepEqual(voiceUps(p), ['voice-up version=latest']);
    r = p.run(['rollback', 'prod', '--target=back']);
    assert.equal(r.status, 0, r.out);
    assert.equal(p.image('testapp_voice_engine:latest'), 'engine-new');
    assert.equal(voiceUps(p).length, 2);
    assert.equal(apiCalls(p).length, 0, 'a rollback never resolves anything');
  } finally { p.cleanup(); }
});

test('manual rollback: no engine touched with VOICE_ENGINE=off, nor without a previous engine image', () => {
  let p = voiceProject('VOICE_ENGINE=off\n');
  try {
    p.seedImage('testapp_back:previous', 'v0');
    p.seedImage('testapp_voice_engine:latest', 'engine-new');
    p.seedImage('testapp_voice_engine:previous', 'engine-old');
    assert.equal(p.run(['rollback', 'prod', '--target=back']).status, 0);
    assert.equal(voiceUps(p).length, 0);
    assert.equal(p.image('testapp_voice_engine:latest'), 'engine-new');
  } finally { p.cleanup(); }
  p = voiceProject('VOICE_ENGINE=on\n');
  try {
    p.seedImage('testapp_back:previous', 'v0');
    const r = p.run(['rollback', 'prod', '--target=back']);
    assert.equal(r.status, 0, r.out);
    assert.equal(voiceUps(p).length, 0);
    assert.match(strip(r.stdout), /No testapp_voice_engine:previous image/);
  } finally { p.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Hygiene of the credential (L4, L5)
// ---------------------------------------------------------------------------------------------------------------------------------

test('xtrace: a deploy run with tracing on never prints the credential, and tracing is back on after the credential steps', () => {
  const p = voiceProject();
  try {
    const r = deploy(p, { SHELLOPTS: 'xtrace' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('+ voice_engine_resolve_latest') || r.out.includes('voice_engine_resolve_latest'), 'the trace was really on');
    assert.ok(!r.out.includes(FAKE_TOKEN), 'the credential is not in the trace');
    assert.ok(!readFileSync(p.log, 'utf8').includes(FAKE_TOKEN));
    assert.match(r.out, /\+ dv_tag_voice_latest/, 'tracing restored after the build step');
  } finally { p.cleanup(); }
});

test('curl runs without SSLKEYLOGFILE (no TLS key log for the credential request)', () => {
  const p = voiceProject();
  try {
    const r = deploy(p, { SSLKEYLOGFILE: '/tmp/vx-should-not-reach-curl.keys' });
    assert.equal(r.status, 0, r.out);
    assert.equal(apiCalls(p).length, 1);
    assert.ok(!readFileSync(path.join(p.state, 'curl_env'), 'utf8').includes('SSLKEYLOGFILE'));
  } finally { p.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The Dockerfile's download: a release tagged `v<version>` or `<version>` (L2). Its RUN script is extracted and run against stub
// curl + the real jq: no Docker, no network.
// ---------------------------------------------------------------------------------------------------------------------------------

function dockerfileDownload({ version, repo = 'svax974/vx-voice-engine', tagsWithRelease }) {
  const root = mkdtempSync(path.join(tmpdir(), 've-df-'));
  try {
    const text = readFileSync(path.join(SCRIPTS_DIR, 'voice-engine', 'Dockerfile'), 'utf8');
    // The RUN instruction of the payload stage: its lines up to the last one without a trailing backslash, joined as Docker does.
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.startsWith('RUN --mount=type=secret,id=gh_token '));
    assert.ok(start >= 0, 'RUN block of the payload stage found');
    let end = start;
    while (lines[end].endsWith('\\')) end += 1;
    const script = lines.slice(start, end + 1).map((l) => l.replace(/\\$/, '')).join(' ').replace('RUN --mount=type=secret,id=gh_token ', '')
      .replaceAll('/run/secrets/gh_token', `${root}/token`).replaceAll('/tmp/engine.tgz', `${root}/engine.tgz`).replaceAll('/out', `${root}/out`);
    write(path.join(root, 'token'), `${FAKE_TOKEN}\n`);
    // payload: a tarball with one file
    write(path.join(root, 'src/vx-voice-engine'), 'engine-binary\n');
    spawnSync('tar', ['-czf', path.join(root, 'payload.tgz'), '-C', path.join(root, 'src'), 'vx-voice-engine']);
    write(path.join(root, 'bin/curl'), `#!/usr/bin/env bash
echo "curl $*" >> "${root}/curl.log"
url="\${!#}"
case "$url" in
  */releases/tags/*)
    tag="\${url##*/releases/tags/}"
    case " ${tagsWithRelease.join(' ')} " in *" $tag "*) printf '{"assets":[{"name":"vx-voice-engine-${version}-linux-amd64.tar.gz","id":4242},{"name":"other","id":1}]}' ;; *) exit 22 ;; esac ;;
  */releases/assets/4242) while [ $# -gt 0 ]; do if [ "$1" = -o ]; then cp "${root}/payload.tgz" "$2"; fi; shift; done ;;
  *) exit 22 ;;
esac
`, 0o755);
    const res = spawnSync('bash', ['-c', script], {
      env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, VOICE_ENGINE_VERSION: version, VOICE_ENGINE_REPO: repo },
      encoding: 'utf8',
    });
    const curlLog = existsSync(path.join(root, 'curl.log')) ? readFileSync(path.join(root, 'curl.log'), 'utf8') : '';
    return { status: res.status, out: res.stdout + res.stderr, curlLog, installed: existsSync(path.join(root, 'out/vx-voice-engine')) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('Dockerfile: a release tagged with a leading v is downloaded', () => {
  const r = dockerfileDownload({ version: '1.4.2', tagsWithRelease: ['v1.4.2'] });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.installed);
});

test('Dockerfile: a release tagged WITHOUT the v is downloaded too (v tried first, then the bare version)', () => {
  const r = dockerfileDownload({ version: '1.4.2', tagsWithRelease: ['1.4.2'] });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.installed);
  const tagCalls = r.curlLog.split('\n').filter((l) => /releases\/tags\//.test(l)).map((l) => l.replace(/.*releases\/tags\//, ''));
  assert.deepEqual(tagCalls, ['v1.4.2', '1.4.2']);
});

test('Dockerfile: no release under either tag fails with a clear message and installs nothing', () => {
  const r = dockerfileDownload({ version: '1.4.2', tagsWithRelease: [] });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /no asset vx-voice-engine-1\.4\.2-linux-amd64\.tar\.gz in the release v1\.4\.2 or 1\.4\.2/);
  assert.ok(!r.installed);
});

test('Dockerfile: a version that is not a release version is refused before any request', () => {
  for (const version of ['v1.4.2', '1.4', '1.0.0; id', '../x']) {
    const r = dockerfileDownload({ version, tagsWithRelease: [version] });
    assert.notEqual(r.status, 0, version);
    assert.match(r.out, /is not a release version/);
    assert.equal(r.curlLog, '');
  }
});
