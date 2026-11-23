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
// Run: node --test scripts/voice-engine-version.test.mjs   (needs bash and python3)

import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { BACK_PROJECT, makeProject, write } from './deploy-test-kit.mjs';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const FAKE_TOKEN = 'ghp_FAKEvoiceReleaseToken0123456789';
const ENGINE_ENV = `VOICE_ENGINE=on\nVOICE_ENGINE_TOKEN=FAKEshared-engine-secret\n`;

// git: `credential fill` answers password=$STUB_VOICE_CRED (nothing when unset), logged WITHOUT its stdin or answer.
const GIT_STUB = (real) => `#!/usr/bin/env bash
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
const docker = (real) => `#!/usr/bin/env bash
case "$*" in
  *" build "*voice-engine*) echo "voice-build version=\${VOICE_ENGINE_VERSION:-<unset>} secret=$([ -n "\${VOICE_ENGINE_RELEASE_TOKEN:-}" ] && echo set)" >> "$STUB_LOG" ;;
esac
exec "${real}" "$@"
`;

function voiceProject(extra = ENGINE_ENV) {
  const p = makeProject({ extraBackEnv: extra });
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
const BACK_PROJECT_VOLUME = `${BACK_PROJECT}_sqlite_data`;

const release = (over = {}) => JSON.stringify({ tag_name: 'v1.4.2', draft: false, prerelease: false, assets: [], ...over });
const deploy = (p, env = {}) => p.run(['prod', '--no-update-common', '--target=back'], { STUB_VOICE_CRED: FAKE_TOKEN, STUB_CURL_BODY: release(), ...env });
const apiCalls = (p) => p.logLines().filter((l) => /^curl .*api\.github\.com/.test(l));
const voiceBuilds = (p) => p.logLines().filter((l) => /^voice-build /.test(l));

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
