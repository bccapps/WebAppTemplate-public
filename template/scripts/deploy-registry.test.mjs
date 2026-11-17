/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Registry mode of deploy-full.sh / run.sh (lib/deploy-images.sh) against STUB executables: build once on a builder, push under an
// immutable tag, every host pulls that tag; --build / --push / --deploy[--tag] phases; the legacy mode stays untouched.
//
// Run: node --test scripts/deploy-registry.test.mjs   (needs bash and python3)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SCRIPTS_DIR, makeProject } from './deploy-test-kit.mjs';

const REGISTRY_ENV = `DEPLOY_REGISTRY=registry.example.com
DEPLOY_REGISTRY_PUSH=localhost:5000
DEPLOY_BUILDER_HOST=builder@10.0.0.9`;
const BUILDER_CTX = 'testctx-builder-10-0-0-9';

const indexOfLine = (lines, re, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Project in registry mode with a running v1 deployed (latest image + sqlite volume). */
function registryProject(extraBackEnv = '') {
  const p = makeProject({ extraBackEnv: `${REGISTRY_ENV}\n${extraBackEnv}` });
  p.seedImage('testapp_back:latest', 'v1');
  p.seedVolume('testapp-back-10-0-0-1_sqlite_data');
  return p;
}

test('without DEPLOY_REGISTRY nothing changes: --build / --push / --tag are refused, the host still builds', () => {
  const p = makeProject();
  p.seedImage('testapp_back:latest', 'v1');
  p.seedVolume('testapp-back-10-0-0-1_sqlite_data');
  try {
    for (const flag of ['--build', '--push', '--tag=x']) {
      const r = p.run(['prod', '--no-update-common', '--target=back', flag]);
      assert.equal(r.status, 1, `${flag}: ${r.out}`);
      assert.match(r.out, /registry mode/);
    }
    assert.equal(indexOfLine(p.logLines(), /compose .* build /), -1, 'refused before anything is built');
    const ok = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(ok.status, 0, ok.out);
    const lines = p.logLines();
    assert.ok(indexOfLine(lines, /^docker .*compose .* build /) >= 0, 'legacy: compose build on the host');
    assert.equal(indexOfLine(lines, /docker pull/), -1);
  } finally { p.cleanup(); }
});

test('registry deploy: built once on the builder, pushed, pulled by the host, tagged as the compose image; state records tag + digest', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const out = strip(r.stdout);
    const lines = p.logLines();

    const build = indexOfLine(lines, new RegExp(`^docker --context ${BUILDER_CTX} build .* -t localhost:5000/testapp/back:abc1234 `));
    const push = indexOfLine(lines, /^ssh .* builder@10\.0\.0\.9 docker push 'localhost:5000\/testapp\/back:abc1234'$/);
    const pull = indexOfLine(lines, /^ssh .* deploy@10\.0\.0\.1 docker pull 'registry\.example\.com\/testapp\/back:abc1234'$/);
    const tagLatest = indexOfLine(lines, /^docker .* tag registry\.example\.com\/testapp\/back:abc1234 testapp_back:latest$/);
    const previous = indexOfLine(lines, /^docker .* tag testapp_back:latest testapp_back:previous$/);
    assert.ok(build >= 0, 'built on the builder daemon');
    assert.ok(push > build, 'pushed from the builder (its own login)');
    assert.ok(previous >= 0 && pull > Math.max(previous, push), 'host pulls after the previous version was kept and after the push');
    assert.ok(tagLatest > pull, 'pulled image tagged as the compose image');
    assert.equal(indexOfLine(lines, /^docker .*compose .* build /), -1, 'no compose build on the host');
    assert.equal(indexOfLine(lines, /^docker --context testctx-10-0-0-1 build /), -1, 'nothing is built on the host');
    assert.match(lines[build], /--build-arg APP_RUNTIME_DIR=shared/);
    assert.match(lines[build], /--label vx\.environment=prod/);
    assert.match(lines[build], /--label org\.opencontainers\.image\.revision=abc1234/);

    assert.equal(p.image('testapp_back:previous'), 'v1');
    assert.equal(p.image('testapp_back:latest'), 'new');

    const state = lines.find((l) => l.startsWith('STATE_JSON: '));
    assert.ok(state, 'state written');
    assert.match(state, /"imageTag":"abc1234"/);
    assert.match(state, /"imageDigest":"sha256:deadbeef"/);
    assert.match(out, /^==> \[IMAGE:testapp\] service=back tag=abc1234 digest=sha256:deadbeef host=10\.0\.0\.1$/m);
    assert.match(out, /^==> \[IMAGE:testapp\] service=back tag=abc1234 digest=sha256:deadbeef builder=10\.0\.0\.9$/m);
  } finally { p.cleanup(); }
});

test('--build builds on the builder and stops: nothing pushed, no host touched, no migration', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back', '--build', '--migrate']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    assert.ok(indexOfLine(lines, new RegExp(`^docker --context ${BUILDER_CTX} build `)) >= 0);
    assert.equal(indexOfLine(lines, /docker push/), -1, 'not pushed');
    assert.equal(indexOfLine(lines, /docker pull/), -1);
    assert.equal(indexOfLine(lines, /deploy@10\.0\.0\.1/), -1, 'the deploy host is never contacted');
    assert.equal(indexOfLine(lines, /compose .* up /), -1);
    assert.equal(indexOfLine(lines, /^migrate-db\.sh/), -1, 'no migration without a deploy');
    assert.match(strip(r.out), /Image phase completed — tag abc1234 \(no host touched\)/);
  } finally { p.cleanup(); }
});

test('--push builds and pushes (implied --build), still no host touched', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back', '--push']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    const build = indexOfLine(lines, /^docker --context \S+ build /);
    const push = indexOfLine(lines, /docker push 'localhost:5000\/testapp\/back:abc1234'/);
    assert.ok(build >= 0 && push > build);
    assert.equal(indexOfLine(lines, /deploy@10\.0\.0\.1/), -1);
    assert.equal(indexOfLine(lines, /docker pull/), -1);
  } finally { p.cleanup(); }
});

test('--deploy --tag=<t> ships an already pushed tag: nothing compiled or built, no library sync, revision = tag', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--target=back', '--deploy', '--tag=v1.2.3']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    assert.equal(indexOfLine(lines, /^update_common\.sh/), -1, 'the library sync is skipped for a deploy-only run');
    assert.equal(indexOfLine(lines, /^npm /), -1, 'nothing is compiled');
    assert.equal(indexOfLine(lines, / build /), -1, 'nothing is built');
    assert.ok(indexOfLine(lines, /docker pull 'registry\.example\.com\/testapp\/back:v1\.2\.3'/) >= 0);
    assert.ok(indexOfLine(lines, /^docker .* tag registry\.example\.com\/testapp\/back:v1\.2\.3 testapp_back:latest$/) >= 0);
    assert.ok(lines.some((l) => /^ENV_SNAPSHOT: DEPLOY_REVISION=v1\.2\.3$/.test(l)), 'the back reports the shipped tag as its revision');
    const state = lines.find((l) => l.startsWith('STATE_JSON: '));
    assert.match(state, /"revision":"v1\.2\.3"/);
    assert.match(state, /"imageTag":"v1\.2\.3"/);
  } finally { p.cleanup(); }
});

test('--deploy without --tag is refused before anything happens', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back', '--deploy']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /needs the tag to ship/);
    assert.equal(indexOfLine(p.logLines(), /deploy@10\.0\.0\.1|docker pull/), -1);
  } finally { p.cleanup(); }
});

test('DEPLOY_BACK_HOSTS of the caller wins over BACK_HOSTS of back/.env (and DEPLOY_REGISTRY over the file)', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { DEPLOY_BACK_HOSTS: '10.0.0.7', DEPLOY_REGISTRY: 'other.example.com' });
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    assert.ok(indexOfLine(lines, /deploy@10\.0\.0\.7 docker pull 'other\.example\.com\/testapp\/back:abc1234'/) >= 0);
    assert.equal(indexOfLine(lines, /deploy@10\.0\.0\.1/), -1, 'the host of the file is ignored');
  } finally { p.cleanup(); }
});

test('a dirty tree never overwrites an immutable tag: the tag carries a timestamp', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back', '--push'], { STUB_GIT_DIRTY: '1' });
    assert.equal(r.status, 0, r.out);
    assert.ok(indexOfLine(p.logLines(), /docker push 'localhost:5000\/testapp\/back:abc1234-dirty-\d{14}'/) >= 0, p.logLines().join('\n'));
  } finally { p.cleanup(); }
});

test('a failed pull stops BEFORE the maintenance window and leaves the running version as it was', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_PULL_FAIL: '1' });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /Pull of registry\.example\.com\/testapp\/back:abc1234 failed/);
    const lines = p.logLines();
    assert.equal(indexOfLine(lines, /rm -sf back back-worker/), -1, 'the old back was never stopped');
    assert.equal(indexOfLine(lines, /compose .* up /), -1);
    assert.equal(p.image('testapp_back:latest'), 'v1');
  } finally { p.cleanup(); }
});

test('a failed push leaves every host untouched', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_PUSH_FAIL: '1' });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /Push of localhost:5000\/testapp\/back:abc1234 failed/);
    assert.equal(indexOfLine(p.logLines(), /deploy@10\.0\.0\.1/), -1);
    assert.equal(p.image('testapp_back:latest'), 'v1');
  } finally { p.cleanup(); }
});

test('back and front container: each service has its own image, the front tag carries the environment', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    assert.ok(indexOfLine(lines, /^docker --context \S+ build .* -t localhost:5000\/testapp\/back:abc1234 /) >= 0);
    assert.ok(indexOfLine(lines, /^docker --context \S+ build .* -t localhost:5000\/testapp\/front:abc1234-prod /) >= 0);
    assert.ok(indexOfLine(lines, /deploy@10\.0\.0\.2 docker pull 'registry\.example\.com\/testapp\/front:abc1234-prod'/) >= 0);
    assert.ok(indexOfLine(lines, /^docker .* tag registry\.example\.com\/testapp\/front:abc1234-prod testapp-front-10-0-0-2-front:latest$/) >= 0);
    assert.equal(indexOfLine(lines, /-t \S*voice/), -1, 'profile-gated services (voice-engine) are not built for the registry');
    assert.equal(indexOfLine(lines, /docker pull '.*voice/), -1);
  } finally { p.cleanup(); }
});

test('--builder=local assembles the image on this machine for linux/amd64 and pushes it from there', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back', '--push', '--builder=local']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    const bx = lines.find((l) => /^docker buildx build /.test(l));
    assert.ok(bx, 'buildx used');
    assert.match(bx, /--platform linux\/amd64/);
    assert.match(bx, /-t localhost:5000\/testapp\/back:abc1234 --push /);
    assert.equal(indexOfLine(lines, /builder@10\.0\.0\.9/), -1, 'no remote builder contacted');
  } finally { p.cleanup(); }
});

test('a back-worker with its own build is refused in registry mode, before anything is built; BACK_WORKER=off lets it through', () => {
  const p = registryProject();
  try {
    let r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_WORKER_BUILD: '1' });
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.out), /does not support a back-worker built from its own context/);
    const lines = p.logLines();
    assert.equal(indexOfLine(lines, /^docker --context \S+ build /), -1, 'nothing built');
    assert.equal(indexOfLine(lines, /docker push/), -1, 'nothing pushed');
    assert.equal(indexOfLine(lines, /deploy@10\.0\.0\.1 docker pull/), -1, 'no host touched');
  } finally { p.cleanup(); }
  const off = registryProject('BACK_WORKER=off');
  try {
    const r = off.run(['prod', '--no-update-common', '--target=back'], { STUB_WORKER_BUILD: '1' });
    assert.equal(r.status, 0, r.out);
  } finally { off.cleanup(); }
});

test('the compose model kept on disk never holds the secrets that `compose config` inlines', () => {
  const p = registryProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back', '--build'], { KEEP_BUILD_CONTEXT: '1' });
    assert.equal(r.status, 0, r.out);
    const ctxDir = readdirSync(p.root).find((d) => d.startsWith('testapp-build-context.'));
    assert.ok(ctxDir, 'build context kept');
    const model = readFileSync(path.join(p.root, ctxDir, '.compose-model.json'), 'utf8');
    assert.doesNotMatch(model, /s3cret-do-not-keep/);
    assert.match(model, /"back"/);
  } finally { p.cleanup(); }
});

test('an image context that is neither a whitelist nor excludes .env is refused for a registry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'di-ign-'));
  try {
    const check = (content) => {
      const ctx = path.join(dir, `c${Math.random().toString(16).slice(2)}`);
      spawnSync('mkdir', ['-p', ctx]);
      if (content !== null) writeFileSync(path.join(ctx, '.dockerignore'), content);
      const res = spawnSync('bash', ['-c', `source "${path.join(SCRIPTS_DIR, 'lib/deploy-images.sh')}"; di_context_is_safe "${ctx}"`], { encoding: 'utf8' });
      return res.status === 0;
    };
    assert.equal(check('*\n!dist\n'), true, 'whitelist (prebuilt)');
    assert.equal(check('node_modules\n.env\n.env.preprod\n'), true, 'canonical, excludes env files');
    assert.equal(check('node_modules\ndist\n'), false, 'no env exclusion');
    assert.equal(check(null), false, 'no .dockerignore at all');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lib/deploy-images.sh passes bash -n and has no BSD-only sed -i', () => {
  const file = path.join(SCRIPTS_DIR, 'lib/deploy-images.sh');
  assert.equal(spawnSync('bash', ['-n', file], { encoding: 'utf8' }).status, 0);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /sed -i ''/);
  assert.ok(existsSync(file));
});
