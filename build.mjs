/**
 * dsh-dev-autoflow — build script.
 *
 * Host half (index.js): plain Node ESM, externalizing @deepseek-ai/dsh-* and
 * cordis (provided by the DSH installation / profile node_modules).
 *
 * Client half (client.js): a single CJS bundle wrapped in the ModuleLoader
 * handshake — the web shell serves exactly one file per plugin
 * (/plugins/dsh-dev-autoflow/client.js) and REQUIRES the bundle to register
 * itself via `window.__ModuleLoader__.load({ id, factory })`. Without this the
 * shell fails the whole boot. react stays external and is provided by the
 * app's module system via the factory's require parameter.
 */
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'

const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*']

// ---- Host half: plain Node ESM -------------------------------------------
await build({
  entryPoints: ['index.ts'],
  outfile: 'index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  external: [...dshExternal, 'yaml'],
  logLevel: 'info',
})

// ---- Client half: CJS bundle wrapped in the ModuleLoader handshake --------
await build({
  entryPoints: ['client.tsx'],
  outfile: 'client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  external: [...dshExternal, 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-dev-autoflow', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

// Minimal host type declaration (the profile only needs the runtime entry).
await writeFile(
  'index.d.ts',
  [
    'export const name: string',
    'export const inject: string[]',
    'export interface Config {',
    '  /** Path to scripts/spec_check.py. Relative paths resolve against the package root. */',
    '  specScript?: string',
    '  /** Path to the case library markdown. Defaults to `<data dir>/cases.md` (~/.dsh/autoflow). */',
    '  caseFile?: string',
    '}',
    'export type StepStatus = "pending" | "active" | "done" | "fail" | "skipped"',
    'export interface StepState {',
    '  key: string',
    '  label: string',
    '  status: StepStatus',
    '  note: string',
    '  updatedAt: number',
    '}',
    'export function apply(ctx: unknown, config?: Config): void',
    'export function resetProgress(sessionKey?: string): void',
    'export function setStepState(sessionKey: string, key: string, status: StepStatus, note?: string): void',
    'export function finishProgress(sessionKey: string, failed?: boolean): void',
    'export function currentProgress(sessionKey?: string): { active: boolean; steps: StepState[] }',
    '',
  ].join('\n'),
)
console.log('build complete: index.js (ESM host), client.js (CJS + __ModuleLoader__ handshake)')
