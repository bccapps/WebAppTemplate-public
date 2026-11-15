/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Invariants of the hardened compose profile (docker-compose-hardened.yml, template README « Hardened compose profile »).
// A summary of what the deployment-side checks enforce, so a template edit that breaks one fails here first:
//   - text checks, always: no host mount, no Docker socket, no forbidden key, XFF rewritten, Redis password never on a
//     command line, every isolation variable fail-closed (`${VAR:?…}`);
//   - rendered checks, when the Docker CLI is installed (`docker compose config` only: no daemon, no host contacted):
//     services, account, read-only root, capabilities, limits, exact ports, fixed network and addresses.
//
// Run: node --test scripts/docker-compose-hardened.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = path.join(SCRIPTS_DIR, 'docker-compose-hardened.yml');
// Without its comment lines (they name what is forbidden: docker.sock…); the nginx heredoc has none.
const SOURCE = readFileSync(COMPOSE_FILE, 'utf8').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

const SERVICES = ['back', 'back-lb', 'back-worker', 'db', 'front', 'redis'];
const CODE_SERVICES = ['back', 'back-worker'];
const FAILCLOSED_VARIABLES = [
  'HARDEN_RUNTIME_UID', 'HARDEN_RUNTIME_GID', 'HARDEN_SUBNET', 'HARDEN_FRONT_IP', 'HARDEN_BACK_LB_IP',
  'HARDEN_BACK_LB_REALIP', 'NODE_PORT', 'VITE_PORT', 'DB_PORT', 'REDIS_PORT', 'REDIS_PASSWORD',
];

// Made-up values (documentation ranges, FAKE secrets built at run time): they only show where each variable lands.
const FAKE_ENV = {
  PROJECT_NAME: 'hardenedtest',
  HARDEN_RUNTIME_UID: '61000',
  HARDEN_RUNTIME_GID: '61001',
  HARDEN_SUBNET: '10.231.73.0/24',
  HARDEN_FRONT_IP: '10.231.73.10',
  HARDEN_BACK_LB_IP: '10.231.73.11',
  HARDEN_BACK_LB_REALIP: 'set_real_ip_from 198.51.100.7; set_real_ip_from 10.231.73.1;',
  VITE_PORT: '4730',
  NODE_PORT: '4731',
  DB_PORT: '4732',
  REDIS_PORT: '4733',
  DB_USER: 'fakeuser',
  DB_NAME: 'fakedb',
  DB_PASSWORD: `FAKE${'-db-'}${process.pid}`,
  REDIS_PASSWORD: `FAKE${'redis'}${process.pid}`,
};

// Only what the CLI needs to find its compose plugin: no variable of the caller reaches the interpolation.
const CLI_ENV = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', env: CLI_ENV }).status === 0;

/** `docker compose config --format json` of the hardened file in a throw-away project layout (scripts/, back/, front/). */
function render(env) {
  const root = mkdtempSync(path.join(tmpdir(), 'hardened-'));
  try {
    for (const dir of ['scripts', 'back', 'front']) mkdirSync(path.join(root, dir));
    const envText = Object.entries(env).map(([k, v]) => `${k}='${v}'\n`).join('');
    writeFileSync(path.join(root, 'back', '.env'), envText);
    writeFileSync(path.join(root, 'front', '.env'), '');
    copyFileSync(COMPOSE_FILE, path.join(root, 'scripts', 'compose.yml'));
    const res = spawnSync('docker', [
      'compose', '-p', 'hardenedtest-back-host', '--project-directory', path.join(root, 'scripts'),
      '-f', path.join(root, 'scripts', 'compose.yml'), '--env-file', path.join(root, 'back', '.env'), 'config', '--format', 'json',
    ], { encoding: 'utf8', env: CLI_ENV });
    return { status: res.status, stderr: res.stderr, config: res.status === 0 ? JSON.parse(res.stdout) : null };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Text of the nginx configuration written by the back-lb heredoc. */
function backLbNginx(text) {
  const match = text.match(/<<'NGINX'\n([\s\S]*?)\n\s*NGINX\n/);
  assert.ok(match, 'back-lb writes its nginx configuration through a QUOTED heredoc');
  return match[1];
}

test('text: no host mount, no Docker socket, no forbidden key, only the allowed env files and build contexts', () => {
  assert.doesNotMatch(SOURCE, /docker\.sock/);
  for (const key of ['privileged', 'cap_add', 'devices', 'volumes_from', 'network_mode', 'pid', 'ipc', 'userns_mode',
    'sysctls', 'extends', 'group_add', 'secrets', 'configs', 'external', 'driver_opts', 'profiles', 'include', 'links']) {
    assert.doesNotMatch(SOURCE, new RegExp(`^\\s*${key}:`, 'm'), key);
  }
  // Volume entries are `<named volume>:<path>`, never a path, `.`, `~` or a variable on the left.
  const volumeEntries = [...SOURCE.matchAll(/^\s*- ([^\s#]+):(\/[^\s]*)$/gm)].map((m) => m[1]);
  assert.ok(volumeEntries.length >= 5, 'volume entries found');
  for (const source of volumeEntries) assert.match(source, /^[a-z][a-z_]*$/, `named volume only: ${source}`);
  for (const [, file] of SOURCE.matchAll(/^\s*- (\.\.\/\S*\.env\S*)$/gm)) assert.equal(file, '../back/.env');
  for (const [, ctx] of SOURCE.matchAll(/^\s*context: (\S+)$/gm)) assert.ok(['../back', '../front'].includes(ctx), ctx);
  const servicesBlock = SOURCE.slice(SOURCE.indexOf('\nservices:\n'), SOURCE.indexOf('\nnetworks:\n'));
  const services = [...servicesBlock.matchAll(/^ {2}([a-z][a-z-]*):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(services.sort(), SERVICES);
});

test('text: back-lb rewrites X-Forwarded-For to the client address, trusts only HARDEN_BACK_LB_REALIP', () => {
  const nginx = backLbNginx(SOURCE);
  assert.doesNotMatch(SOURCE, /proxy_add_x_forwarded_for/);
  assert.match(nginx, /^\s*\$\{HARDEN_BACK_LB_REALIP\}\s*$/m);
  assert.doesNotMatch(nginx, /set_real_ip_from/, 'the relays come from HARDEN_BACK_LB_REALIP only');
  assert.match(nginx, /^\s*real_ip_header X-Forwarded-For;$/m);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$\$remote_addr;/);
  assert.match(nginx, /if \(-f \/etc\/nginx\/maintenance\.flag\)/, 'maintenance mode of deploy-full.sh');
});

test('text: Redis password never on a command line; every isolation variable fails closed', () => {
  assert.doesNotMatch(SOURCE, /--requirepass|redis-cli[^\n]*\s-a\s/);
  assert.match(SOURCE, /printf 'requirepass %s\\n[^\n]*"\$\$REDIS_PASSWORD" > \/data\/redis\.conf/);
  assert.match(SOURCE, /REDISCLI_AUTH=\\"\$\$REDIS_PASSWORD\\" redis-cli ping/);
  for (const name of FAILCLOSED_VARIABLES) assert.match(SOURCE, new RegExp(`\\$\\{${name}:\\?`), `${name} is \${${name}:?…}`);
});

test('rendered: account, read-only root, capabilities, limits, ports, network and addresses', { skip: !hasCompose && 'docker compose not installed' }, () => {
  const { status, stderr, config } = render(FAKE_ENV);
  assert.equal(status, 0, stderr);
  const { services, networks, volumes } = config;
  assert.deepEqual(Object.keys(services).sort(), SERVICES);
  assert.deepEqual(Object.keys(networks), ['app']);
  assert.deepEqual(networks.app.ipam.config, [{ subnet: FAKE_ENV.HARDEN_SUBNET }]);
  assert.equal(networks.app.external, undefined);
  for (const [name, volume] of Object.entries(volumes)) {
    assert.equal(volume.name, `hardenedtest-back-host_${name}`, `volume ${name} belongs to the project`);
    assert.equal(volume.driver_opts, undefined);
  }
  for (const [name, svc] of Object.entries(services)) {
    assert.equal(svc.restart, 'unless-stopped', name);
    assert.deepEqual(svc.security_opt, ['no-new-privileges:true'], name);
    assert.deepEqual(Object.keys(svc.networks), ['app'], name);
    assert.ok(Number(svc.mem_limit) > 0 && Number(svc.cpus) > 0, `${name}: memory and CPU limits`);
    for (const mount of svc.volumes ?? []) assert.equal(mount.type, 'volume', `${name}: ${mount.source}`);
    assert.equal(svc.privileged, undefined, name);
    assert.equal(svc.cap_add, undefined, name);
  }
  for (const name of CODE_SERVICES) {
    const svc = services[name];
    assert.equal(svc.user, `${FAKE_ENV.HARDEN_RUNTIME_UID}:${FAKE_ENV.HARDEN_RUNTIME_GID}`, name);
    assert.equal(svc.read_only, true, name);
    assert.deepEqual(svc.tmpfs, ['/tmp'], name);
    assert.deepEqual(svc.cap_drop, ['ALL'], name);
    assert.ok(svc.pids_limit > 0, name);
    assert.equal(svc.ports, undefined, `${name} publishes nothing`);
  }
  assert.equal(services.back.build.args.APP_RUNTIME_OWNER, `${FAKE_ENV.HARDEN_RUNTIME_UID}:${FAKE_ENV.HARDEN_RUNTIME_GID}`);
  const ports = (name) => (services[name].ports ?? []).map((p) => `${p.host_ip}:${p.published}:${p.target}`);
  assert.deepEqual(ports('front'), [`0.0.0.0:${FAKE_ENV.VITE_PORT}:80`]);
  assert.deepEqual(ports('back-lb'), [`0.0.0.0:${FAKE_ENV.NODE_PORT}:${FAKE_ENV.NODE_PORT}`]);
  assert.deepEqual(ports('db'), [`127.0.0.1:${FAKE_ENV.DB_PORT}:5432`]);
  assert.deepEqual(ports('redis'), [`127.0.0.1:${FAKE_ENV.REDIS_PORT}:6379`]);
  assert.equal(services.front.networks.app.ipv4_address, FAKE_ENV.HARDEN_FRONT_IP);
  assert.equal(services['back-lb'].networks.app.ipv4_address, FAKE_ENV.HARDEN_BACK_LB_IP);
  // `config` inlines env_file contents into `environment`: db gets its own values only, the front none of the app secrets.
  assert.deepEqual(Object.keys(services.db.environment).sort(),
    ['POSTGRES_DB', 'POSTGRES_HOST_AUTH_METHOD', 'POSTGRES_INITDB_ARGS', 'POSTGRES_PASSWORD', 'POSTGRES_USER']);
  assert.equal(services.front.environment, undefined);
  assert.deepEqual(Object.keys(services.redis.environment), ['REDIS_PASSWORD']);
  assert.ok('DB_PASSWORD' in services.back.environment, 'code services read back/.env');
  // `docker compose config` re-escapes `$` as `$$` (its output is a compose file itself).
  const nginx = backLbNginx(services['back-lb'].entrypoint.join('\n')).replaceAll('$$', '$');
  assert.match(nginx, new RegExp(`^\\s*${FAKE_ENV.HARDEN_BACK_LB_REALIP.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(nginx, new RegExp(`proxy_pass http://back:${FAKE_ENV.NODE_PORT};`));
});

test('rendered: a missing isolation variable refuses the whole file (fail closed)', { skip: !hasCompose && 'docker compose not installed' }, () => {
  for (const name of FAILCLOSED_VARIABLES) {
    const env = { ...FAKE_ENV };
    delete env[name];
    const { status, stderr } = render(env);
    assert.notEqual(status, 0, `${name} unset must fail`);
    assert.match(stderr, new RegExp(name), name);
  }
});
