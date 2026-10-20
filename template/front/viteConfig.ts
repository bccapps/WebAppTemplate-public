/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Shared Vite config factory for all front projects. Lives in the app-template
 * submodule and is consumed by each project's thin `vite.config.ts`:
 *
 *   import { createViteConfig } from './viteConfig'
 *   import { Configuration } from './src/config/config'
 *   export default createViteConfig({ configuration: Configuration })
 *
 * Project-relative paths use `process.cwd()` (the project's front/ dir when Vite
 * runs) so this file is fully relocatable — it never references its own location.
 * Per-project values are passed as options by the thin wrapper (explicit and
 * version-controlled); matching VITE_* env vars override them when present.
 * `Configuration['apiUrl']` is the final fallback dev API proxy path.
 *
 * Precedence for each tunable: env var > wrapper option > default.
 *   VITE_PORT             dev/preview port (default 8080)
 *   VITE_API_PORT         backend port for the dev proxy target
 *   VITE_ALLOWED_HOSTS    comma-separated; overrides opts.allowedHosts
 *   VITE_API_PROXY_PATH   dev proxy path key; overrides opts.apiProxyPath
 *   VITE_STRICT_PORT      "true"/"false"; overrides opts.strictPort
 *   VITE_REOWN_PROJECT_ID injected into import.meta.env
 */

import { defineConfig, loadEnv, type Plugin, type PluginOption, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { libRoots } from './libRoots'

export interface ViteConfigOptions {
  /** Project Configuration object (from ./src/config/config), read for the dev proxy path. */
  configuration?: Record<string, unknown>
  /** Dev server allowedHosts (default ["localhost", "127.0.0.1"]). */
  allowedHosts?: string[]
  /** Dev proxy path key (default Configuration.apiUrl || "/api"). */
  apiProxyPath?: string
  /** Fail instead of auto-incrementing when the port is taken (default false). */
  strictPort?: boolean
  /**
   * Extra Vite plugins appended after react(). Use to add app-specific plugins
   * (e.g. VitePWA) without modifying this shared factory.
   * @example extraPlugins: [VitePWA({ ... })]
   */
  extraPlugins?: PluginOption[]
  /**
   * Vite's resolved mode, from the config function form: `defineConfig(({ mode }) => ...)`.
   * Passed through explicitly rather than re-derived here (see `dropConsoleInProduction`
   * below) — this factory's own `loadEnv(process.env.MODE || 'development', ...)` call a few
   * lines down does NOT track the real `--mode` flag (nothing sets `process.env.MODE` for
   * `vite build --mode preprod`), so re-deriving mode internally would silently treat a
   * preprod build as production.
   */
  mode?: string
  /**
   * `VITE_*` names that look like credentials (see `SECRET_ENV_NAME_RE`) but are PUBLIC by design and may reach the
   * bundle, e.g. a publishable key. Anything else matching the pattern fails the production build.
   * @example allowPublicEnv: ['VITE_OPENFORT_PUBLISHABLE_KEY']
   */
  allowPublicEnv?: string[]
}

/**
 * `import.meta.env ? import.meta.env.X : void 0` (zustand's devtools middleware, pulled in by
 * wagmi/reown) — and the `&&` variant — make Vite inline the WHOLE env object (every VITE_*
 * value, secrets included) into the chunk. Rewritten to `import.meta.env.X`, which Vite replaces
 * by that single value.
 */
// The ternary must end the expression (next token `)` `;` `,` `}` `]` or EOL), so that
// `c ? a : void 0 !== x` (= `c ? a : (void 0 !== x)`) is never rewritten.
const ENV_GUARD_RE = /import\.meta\.env\s*\?\s*import\.meta\.env\.([A-Za-z_$][\w$]*)\s*:\s*(?:void 0|undefined)(?=\s*(?:[),;}\]]|$))/gm
const ENV_AND_RE = /import\.meta\.env\s*&&\s*import\.meta\.env\.([A-Za-z_$][\w$]*)/g

export function rewriteEnvGuards(code: string): string {
  return code
    .replace(ENV_GUARD_RE, (_m, key: string) => `(import.meta.env.${key})`)
    .replace(ENV_AND_RE, (_m, key: string) => `import.meta.env.${key}`)
}

/** VITE_* names that look like credentials: their value must never reach the public bundle. */
export const SECRET_ENV_NAME_RE = /TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY/i

/** Names of secret-looking VITE_* variables (minus the `allowed` public ones) whose value appears in `content`. */
export function findLeakedEnvSecrets(env: Record<string, unknown>, content: string, allowed: readonly string[] = []): string[] {
  return Object.entries(env)
    .filter(([name, value]) => name.startsWith('VITE_') && SECRET_ENV_NAME_RE.test(name) && !allowed.includes(name)
      && typeof value === 'string' && value.length >= 8 && content.includes(value))
    .map(([name]) => name)
}

/**
 * (a) rewrites the env-object guards above; (b) at bundle time, FAILS the build when the value of a
 * secret-looking VITE_* variable is emitted, unless its name is in `allowPublicEnv` (a key that is public by design).
 * The value itself is never printed.
 */
export function envGuardPlugin(allowPublicEnv: readonly string[] = []): Plugin {
  let env: Record<string, unknown> = {}
  return {
    name: 'vx-env-guard',
    enforce: 'pre',
    configResolved(config) {
      env = config.env ?? {}
    },
    transform(code) {
      if (!code.includes('import.meta.env')) return null
      if (!ENV_GUARD_RE.test(code) && !ENV_AND_RE.test(code)) return null
      ENV_GUARD_RE.lastIndex = 0
      ENV_AND_RE.lastIndex = 0
      return { code: rewriteEnvGuards(code), map: null }
    },
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        const content = output.type === 'chunk' ? output.code : typeof output.source === 'string' ? output.source : ''
        const leaked = findLeakedEnvSecrets(env, content, allowPublicEnv)
        if (leaked.length > 0) {
          this.error(`${leaked.join(', ')} inlined into the public bundle (${fileName}). VITE_* values are readable by every visitor: move the secret to the back, or list a genuinely public key in createViteConfig({ allowPublicEnv }).`)
        }
      }
    },
  }
}

export function createViteConfig(opts: ViteConfigOptions = {}): UserConfig {
  const cwd = process.cwd()
  const env = loadEnv(process.env.MODE || 'development', cwd, 'VITE_')

  const allowedHosts = env.VITE_ALLOWED_HOSTS
    ? env.VITE_ALLOWED_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
    : opts.allowedHosts ?? ['localhost', '127.0.0.1']
  const apiProxyPath =
    env.VITE_API_PROXY_PATH ||
    opts.apiProxyPath ||
    (opts.configuration?.['apiUrl'] as string | undefined) ||
    '/api'
  const strictPort = env.VITE_STRICT_PORT
    ? env.VITE_STRICT_PORT === 'true'
    : opts.strictPort ?? false
  const port = parseInt(env.VITE_PORT, 10) || 8080

  // Strip console.*/debugger from the bundle for the real production build ONLY — dev and
  // preprod (and any other named mode) keep full console output. Build-time removal (the Oxc
  // minifier's `dropConsole`, not a runtime console shim) means nothing to silently re-enable and
  // a smaller bundle, at the cost of needing a rebuild to see logs again — acceptable since prod
  // logs are meant to stay off. Guarded on the caller-supplied `mode`, not on env vars read inside
  // this factory (see the `mode` option doc above).
  const dropConsoleInProduction = opts.mode === 'production'

  return defineConfig({
    define: {
      global: 'window',
      'process.env': {},
      'import.meta.env.VITE_REOWN_PROJECT_ID': JSON.stringify(env.VITE_REOWN_PROJECT_ID || ''),
    },
    server: {
      port,
      strictPort,
      allowedHosts,
      fs: {
        allow: [cwd, ...libRoots(cwd)],
      },
      // Streams (SSE, /events/stream) pass through unbuffered and uncompressed: http-proxy forwards chunks as they
      // come and Vite adds no compression; the back marks them `no-transform`.
      proxy: {
        [apiProxyPath]: {
          target: 'http://localhost:' + env.VITE_API_PORT,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      port,
    },
    plugins: [envGuardPlugin(opts.allowPublicEnv), react(), ...(opts.extraPlugins ?? [])],
    build: {
      // Vendor chunks like the web3 stack are legitimately large; lift the warn
      // threshold so it only fires on genuinely oversized chunks, not expected ones.
      chunkSizeWarningLimit: 1200,
      // No manual vendor chunks: Rolldown (Vite 8) turns `manualChunks` into code-splitting groups that pull each
      // group's dependencies in (React landed in vendor-charts, +30% critical-path JS); its automatic splitting is
      // as small and keeps the module execution order. Spread, never `minify: undefined`: Vite spreads `output`
      // last and an undefined key would turn minification off.
      rolldownOptions: {
        output: {
          ...(dropConsoleInProduction ? { minify: { compress: { dropConsole: true, dropDebugger: true } } } : {}),
        },
      },
    },
    resolve: {
      preserveSymlinks: true,
      alias: {
        '@': path.resolve(cwd, './src'),
        buffer: 'buffer',
      },
    },
    optimizeDeps: {
      include: ['buffer'],
    },
  }) as UserConfig
}
