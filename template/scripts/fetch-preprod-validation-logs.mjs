#!/usr/bin/env node
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * READ-ONLY copy of the preprod validation traces (`validation-YYYY-MM-DD.jsonl` of the back containers) into
 * `.validation-cache/preprod/` (git-ignored, 0700/0600), for `validation-report.mjs --preprod`.
 *
 *   node scripts/fetch-preprod-validation-logs.mjs [--root <project>] [--since 7d] [--max-files 8] [--max-mb 20] [--dry-run]
 *
 * Same channel as deploy-full.sh: the SSH user/host/port/key of `back/.env.preprod` (BACK_HOSTS | BACK_REMOTE_HOST |
 * REMOTE_HOST, BACK_REMOTE_USER | REMOTE_USER, BACK_SSH_PORT | REMOTE_SSH_PORT, BACK_SSH_KEY_FILE | SSH_KEY_FILE,
 * PROJECT_NAME), then `docker` on the host, as that user, against the containers of the compose project deploy-full.sh
 * created (`<PROJECT_NAME>-back-<host>`, services `back` and `back-worker`). The files are read in LOG_DIR (else
 * <APP_DATA_DIR>/logs, else /app/logs) inside the container.
 * Safety: only the keys above are read from the env file (never sourced, never printed, never exported); every value is
 * checked against a strict pattern before use; the remote commands come from a fixed allow-list (docker ps, ls,
 * tail -c) with checked, quoted arguments; ssh runs with BatchMode=yes, StrictHostKeyChecking=yes, a short
 * ConnectTimeout, no forwarding; nothing is written on the server; transfer bounded by --since, --max-files, --max-mb.
 * Exit: 0 ok · 2 configuration refused (missing or unsafe value) · 3 SSH or remote failure.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSince } from './lib/validation-logs.mjs';

export const ENV_KEYS = Object.freeze([
  'PROJECT_NAME', 'BACK_HOSTS', 'BACK_REMOTE_HOST', 'REMOTE_HOST', 'BACK_REMOTE_USER', 'REMOTE_USER',
  'BACK_SSH_PORT', 'REMOTE_SSH_PORT', 'BACK_SSH_KEY_FILE', 'SSH_KEY_FILE', 'LOG_DIR', 'APP_DATA_DIR',
]);
const SAFE = {
  project: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  composeProject: /^[a-z0-9][a-z0-9_-]{0,191}$/,
  host: /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:]{2,39})$/,
  user: /^[a-z_][a-z0-9_-]{0,31}$/,
  port: /^\d{1,5}$/,
  container: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
  dir: /^\/[A-Za-z0-9._/-]{1,200}$/,
  file: /^validation-(\d{4}-\d{2}-\d{2})\.jsonl$/,
};
const SERVICES = new Set(['back', 'back-worker']);
const LIMITS = { maxFiles: 31, maxMb: 100, totalBytes: 300 * 1024 * 1024, sinceDays: 31 };

export class FetchError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}
const refuse = (message) => new FetchError(message, 2);

/**
 * Only the `keys` of a `KEY=value` env file (no expansion, no execution; the last assignment wins, like `source`). A
 * quoted value may span several lines (a certificate): its lines are part of the value, never read as assignments.
 */
export function parseEnvFile(text, keys = ENV_KEYS) {
  const wanted = new Set(keys);
  const values = {};
  const lines = text.replace(/^\ufeff/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(lines[i]);
    if (!match) continue;
    let value = match[2].trim();
    const quote = /^["']/.exec(value)?.[0];
    if (quote) {
      let close = value.indexOf(quote, 1);
      if (close === -1) {
        const end = lines.findIndex((line, at) => at > i && line.includes(quote));
        if (end === -1) throw refuse(`${match[1]}: unterminated quoted value in back/.env.preprod`);
        value = [value, ...lines.slice(i + 1, end + 1)].join('\n');
        close = value.indexOf(quote, 1);
        i = end;
      }
      value = value.slice(1, close); // the quoted text; what follows the closing quote (a comment) is dropped
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if (wanted.has(match[1])) values[match[1]] = value;
  }
  return values;
}

function checked(name, value, pattern) {
  if (!pattern.test(value) || (pattern === SAFE.dir && value.split('/').includes('..'))) {
    throw refuse(`${name}: unsafe or invalid value in back/.env.preprod (refused; it is not shown)`);
  }
  return value;
}

/** Remote log directory: LOG_DIR, else <APP_DATA_DIR>/logs, else /app/logs (relative paths resolved from the image WORKDIR /app). */
export function remoteLogDir(env) {
  const raw = [env.LOG_DIR, env.APP_DATA_DIR].map((value) => value?.trim() ?? '');
  if (raw.some((value) => value.split('/').includes('..'))) throw refuse('LOG_DIR / APP_DATA_DIR: ".." is not allowed');
  const base = raw[0] || (raw[1] ? path.posix.join(raw[1], 'logs') : '/app/logs');
  const dir = path.posix.normalize(base.startsWith('/') ? base : path.posix.join('/app', base));
  return checked('LOG_DIR / APP_DATA_DIR', dir.replace(/\/$/, ''), SAFE.dir);
}

function resolveKeyFile(keyFile) {
  if (!keyFile) return '';
  if (keyFile.startsWith('-')) throw refuse('SSH_KEY_FILE: invalid value (refused)');
  for (const candidate of [keyFile, path.join(homedir(), '.ssh', keyFile)]) if (existsSync(candidate)) return candidate;
  throw refuse('SSH key file of BACK_SSH_KEY_FILE / SSH_KEY_FILE not found (looked as given and in ~/.ssh)');
}

/** compose project of a back host, as deploy-full.sh's build_project_name("back", host). */
export function composeProjectName(project, host) {
  return `${project}-back-${host.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.toLowerCase();
}

/** Targets of `back/.env.preprod`, every value checked (throws FetchError(2) without ever quoting a value). */
export function resolveTargets(env) {
  const project = checked('PROJECT_NAME', env.PROJECT_NAME?.trim() ?? '', SAFE.project);
  const rawHosts = env.BACK_HOSTS || env.BACK_REMOTE_HOST || env.REMOTE_HOST || '';
  const entries = rawHosts.split(',').map((h) => h.trim()).filter(Boolean);
  if (!entries.length) throw refuse('no back host: set BACK_HOSTS (or REMOTE_HOST) in back/.env.preprod, as for deploy-full.sh');
  const defaultUser = (env.BACK_REMOTE_USER || env.REMOTE_USER || 'ubuntu').trim();
  const port = checked('BACK_SSH_PORT / REMOTE_SSH_PORT', (env.BACK_SSH_PORT || env.REMOTE_SSH_PORT || '22').trim(), SAFE.port);
  if (Number(port) < 1 || Number(port) > 65535) throw refuse('BACK_SSH_PORT / REMOTE_SSH_PORT: out of range');
  const keyFile = resolveKeyFile((env.BACK_SSH_KEY_FILE || env.SSH_KEY_FILE || '').trim());
  const logDir = remoteLogDir(env);
  return entries.map((entry, index) => {
    const at = entry.lastIndexOf('@');
    const user = checked('back host user', at >= 0 ? entry.slice(0, at) : defaultUser, SAFE.user);
    const host = checked('back host', at >= 0 ? entry.slice(at + 1) : entry, SAFE.host);
    const composeProject = checked('compose project', composeProjectName(project, host), SAFE.composeProject);
    return { label: `back host #${index + 1}`, user, host, port, keyFile, logDir, composeProject };
  });
}

const quote = (name, value, pattern) => `'${checked(name, value, pattern)}'`;

/**
 * The ONLY commands ever run on the server (read-only). Every argument is checked against a strict pattern (no quote,
 * no space, no shell metacharacter can pass) and single-quoted.
 */
export const REMOTE_COMMANDS = Object.freeze({
  containers: (project) =>
    `docker ps --format '{{.Names}}|{{.Label "com.docker.compose.service"}}' --filter ${quote('compose project', `label=com.docker.compose.project=${project}`, /^label=com\.docker\.compose\.project=[a-z0-9][a-z0-9_-]{0,191}$/)}`,
  list: (container, dir) => `docker exec ${quote('container', container, SAFE.container)} ls -1 -- ${quote('log dir', dir, SAFE.dir)}`,
  read: (container, dir, file, bytes) =>
    `docker exec ${quote('container', container, SAFE.container)} tail -c ${checked('byte count', String(bytes), /^[1-9]\d{0,9}$/)} -- ${quote('log file', `${checked('log dir', dir, SAFE.dir)}/${checked('log file', file, SAFE.file)}`, SAFE.dir)}`,
});

/** ssh arguments: no prompt, known host keys only, short timeouts, no forwarding of any kind. */
export function sshArgs(target, command) {
  return [
    '-T', '-p', target.port,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'LogLevel=ERROR',
    ...(target.keyFile ? ['-i', target.keyFile, '-o', 'IdentitiesOnly=yes'] : []),
    '--', `${target.user}@${target.host}`, command,
  ];
}

/** Human reason of an ssh failure (exit 255), from its stderr; the stderr itself is never printed (it names the host). */
export function sshFailureReason(stderr) {
  if (/host key verification failed|remote host identification has changed|no .*host key is known/i.test(stderr)) {
    return 'host key unknown or changed: verify it, then add it to ~/.ssh/known_hosts (one interactive ssh, or a deploy)';
  }
  if (/permission denied/i.test(stderr)) return 'SSH key refused (BatchMode: no password prompt; check BACK_SSH_KEY_FILE / SSH_KEY_FILE and ssh-agent)';
  if (/could not resolve hostname/i.test(stderr)) return 'host name not resolvable';
  if (/timed out|connection refused|no route to host|network is unreachable/i.test(stderr)) return 'host unreachable';
  return 'SSH connection failed';
}

/** The only variables ssh gets: what it needs to find its config, its known_hosts and the agent; nothing else leaks to it. */
export function sshEnvironment(env = process.env) {
  return Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK'].filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

function run(target, command, maxBytes) {
  const result = spawnSync('ssh', sshArgs(target, command), { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: maxBytes + 65536, timeout: 300_000, env: sshEnvironment() });
  if (result.error?.code === 'ENOENT') throw new FetchError('ssh is not installed on this machine', 3);
  if (result.error) throw new FetchError(`${target.label}: SSH command did not complete (${result.error.code ?? 'error'})`, 3);
  if (result.status === 255) throw new FetchError(`${target.label}: ${sshFailureReason(String(result.stderr))}`, 3);
  return { ok: result.status === 0, stdout: result.stdout };
}

export function parseOptions(argv) {
  const options = { since: '7d', maxFiles: 8, maxMb: 20, dryRun: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const [arg, value] = [argv[i], argv[i + 1]];
    if (arg === '--dry-run') options.dryRun = true;
    else if (['--root', '--since', '--max-files', '--max-mb'].includes(arg) && value !== undefined) {
      options[{ '--root': 'root', '--since': 'since', '--max-files': 'maxFiles', '--max-mb': 'maxMb' }[arg]] = value;
      i += 1;
    } else throw refuse(`unknown or incomplete option: ${arg}`);
  }
  options.maxFiles = Number(options.maxFiles);
  options.maxMb = Number(options.maxMb);
  if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > LIMITS.maxFiles) throw refuse(`--max-files: 1..${LIMITS.maxFiles}`);
  if (!Number.isInteger(options.maxMb) || options.maxMb < 1 || options.maxMb > LIMITS.maxMb) throw refuse(`--max-mb: 1..${LIMITS.maxMb}`);
  const since = parseSince(options.since);
  if (since === null || Date.now() - since > LIMITS.sinceDays * 86_400_000) throw refuse(`--since: a duration or date within the last ${LIMITS.sinceDays} days`);
  options.sinceMs = since;
  return options;
}

/** Validation files of a listing, newest first, within --since and --max-files (anything else in the directory is ignored). */
export function selectFiles(listing, sinceMs, maxFiles) {
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);
  return listing
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => SAFE.file.test(name) && SAFE.file.exec(name)[1] >= sinceDay)
    .sort()
    .reverse()
    .slice(0, maxFiles);
}

function containersOf(target) {
  const { ok, stdout } = run(target, REMOTE_COMMANDS.containers(target.composeProject), 1024 * 1024);
  if (!ok) throw new FetchError(`${target.label}: docker is not usable by the SSH user (docker ps failed)`, 3);
  return String(stdout)
    .split('\n')
    .map((line) => line.trim().split('|'))
    .filter(([name, service]) => SERVICES.has(service) && SAFE.container.test(name ?? ''))
    .map(([name, service]) => ({ name, service }));
}

function writePrivate(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Last `maxBytes` of a file (the whole file when smaller); when it may have been cut, the first (partial) line is dropped. */
function readTail(target, container, file, maxBytes) {
  const { ok, stdout } = run(target, REMOTE_COMMANDS.read(container, target.logDir, file, maxBytes), maxBytes);
  if (!ok || !stdout.length) return null;
  const data = stdout.subarray(0, maxBytes);
  return data.length >= maxBytes ? data.subarray(data.indexOf(10) + 1) : data;
}

function fetchContainer(target, container, outDir, options, budget) {
  const listing = run(target, REMOTE_COMMANDS.list(container.name, target.logDir), 1024 * 1024);
  if (!listing.ok) return 0;
  let written = 0;
  for (const file of selectFiles(String(listing.stdout), options.sinceMs, options.maxFiles)) {
    const maxBytes = Math.min(options.maxMb * 1024 * 1024, budget.left);
    if (maxBytes <= 0) break;
    const data = readTail(target, container.name, file, maxBytes);
    if (!data) continue;
    writePrivate(path.join(outDir, file), data);
    budget.left -= data.length;
    written += 1;
  }
  return written;
}

function fetchInto(out, targets, options) {
  const budget = { left: LIMITS.totalBytes };
  let files = 0;
  for (const [hostIndex, target] of targets.entries()) {
    const counters = {};
    for (const container of containersOf(target)) {
      counters[container.service] = (counters[container.service] ?? 0) + 1;
      const dir = path.join(out, `host${hostIndex + 1}`, `${container.service}-${counters[container.service]}`);
      files += fetchContainer(target, container, dir, options, budget);
    }
  }
  return files;
}

/**
 * Replaces the previous copy atomically (short local retention): everything is fetched into a fresh private directory
 * of `.validation-cache/`, which then takes the place of `preprod/`; on failure the previous copy is left as it was.
 */
export function fetchAll(targets, cacheRoot, options) {
  const fresh = mkdtempSync(path.join(cacheRoot, 'preprod.tmp-'));
  try {
    const files = fetchInto(fresh, targets, options);
    const out = path.join(cacheRoot, 'preprod');
    const old = existsSync(out) ? `${fresh}.old` : null;
    if (old) renameSync(out, old);
    renameSync(fresh, out);
    if (old) rmSync(old, { recursive: true, force: true });
    return files;
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
}

/** Whether something that is not a real directory (a symbolic link, even dangling, or a file) sits at `target`. */
function isOtherThanDirectory(target) {
  try {
    return !lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** `.validation-cache/` (0700) with its own `.gitignore` (`*`): nothing fetched can be committed. */
export function ensureCache(root) {
  const dir = path.join(root, '.validation-cache');
  for (const target of [dir, path.join(dir, 'preprod')]) {
    if (isOtherThanDirectory(target)) throw refuse(`${path.relative(root, target)} is not a plain directory (symbolic link refused)`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(path.join(dir, '.gitignore'))) writeFileSync(path.join(dir, '.gitignore'), '*\n', { mode: 0o600 });
  return dir;
}

function dryRun(targets) {
  const sample = { ...targets[0], user: 'USER', host: 'HOST', port: 'PORT', keyFile: targets[0].keyFile ? 'KEY_FILE' : '' };
  console.log(`[fetch-preprod] ${targets.length} back host(s); remote log dir and names are not shown. Commands (placeholders):`);
  console.log(`  ssh ${sshArgs(sample, '<command>').join(' ')}`);
  for (const name of Object.keys(REMOTE_COMMANDS)) console.log(`  <command> = ${name}: docker … (see REMOTE_COMMANDS)`);
}

export function main(argv) {
  const options = parseOptions(argv);
  const root = path.resolve(options.root);
  const envFile = path.join(root, 'back', '.env.preprod');
  if (!existsSync(envFile)) throw refuse('back/.env.preprod not found: the preprod SSH settings live there (same as deploy-full.sh)');
  const targets = resolveTargets(parseEnvFile(readFileSync(envFile, 'utf8')));
  if (options.dryRun) return dryRun(targets);
  const files = fetchAll(targets, ensureCache(root), options);
  console.log(`[fetch-preprod] ${files} validation file(s) copied to .validation-cache/preprod (read-only access, ${targets.length} back host(s))`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[fetch-preprod] ${error instanceof FetchError ? error.message : 'unexpected error'}`);
    process.exitCode = error instanceof FetchError ? error.exitCode : 3;
  }
}
