#!/usr/bin/env node
/**
 * verify-plugin.mjs — minimal DSH Plugin Standard v2.0 static gate.
 *
 * Checks the MUST clauses that are machine-checkable without a DSH runtime:
 *   - package.json: type=module, main/types/exports point at real files
 *   - exports["./client"] exists AND dsh.client.platform === "web" (client contract)
 *   - dsh.bundle.patch points at a real cordis.patch.yml
 *   - name agreement: package.json.name === patch insert name
 *
 * Usage: node scripts/verify-plugin.mjs [plugin-dir]
 * Exit:   0 = no MUST violation, 1 = MUST violation, 2 = unusable dir
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'yaml'

const dir = resolve(process.argv[2] ?? '.')
const violations = []

async function main() {
  const pkgPath = join(dir, 'package.json')
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(pkgPath)) {
    console.error('FAIL: package.json missing')
    process.exit(2)
  }

  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))

  // 2.1.1 type: module
  if (pkg.type !== 'module') violations.push('2.1.1: type must be "module"')

  // 2.1.2 main/types/exports point to real files
  for (const key of ['main', 'types']) {
    if (pkg[key] && !existsSync(join(dir, pkg[key]))) {
      violations.push(`2.1.2: ${key} points to missing file ${pkg[key]}`)
    }
  }

  const hasClient = Boolean(pkg.exports?.['./client'])
  if (hasClient && pkg.dsh?.client?.platform !== 'web') {
    violations.push('2.1.3: exports["./client"] present but dsh.client.platform !== "web"')
  }
  if (hasClient && !existsSync(join(dir, pkg.exports['./client']))) {
    violations.push('2.1.3: exports["./client"] points to missing file')
  }

  // 2.1.4 dsh.bundle.patch real YAML
  const patchRef = pkg.dsh?.bundle?.patch
  if (!patchRef || !existsSync(join(dir, patchRef))) {
    violations.push('2.1.4: dsh.bundle.patch must point at a real file')
  } else {
    const patch = await readFile(join(dir, patchRef), 'utf8')
    if (!patch.includes('- insert:')) violations.push('2.2.1: cordis.patch.yml must be a top-level array with insert rows')
  }

  // 2.1.7 name agreement
  if (patchRef && existsSync(join(dir, patchRef))) {
    const patch = await readFile(join(dir, patchRef), 'utf8')
    const match = patch.match(/name:\s*([^\s]+)/)
    if (match && match[1] !== pkg.name) {
      violations.push(`2.1.7: patch insert name "${match[1]}" !== package name "${pkg.name}"`)
    }

    // Preset declaration gate: the patch must declare the 自动流 agent preset
    // (mode-picker entry) in the same declarative shape dsh-paper-reader uses.
    let parsed
    try {
      parsed = yaml.parse(patch)
    } catch (error) {
      violations.push(`preset: cordis.patch.yml is not valid YAML (${error instanceof Error ? error.message : String(error)})`)
    }
    if (parsed) {
      const insertRows = (parsed[0]?.insert ?? [])
      const ids = insertRows.map((r) => r.id).filter(Boolean)
      if (new Set(ids).size !== ids.length) violations.push('preset: insert row ids must be unique')
      const preset = insertRows.find((r) => r.name === '@deepseek-ai/dsh-agent-preset')
      if (!preset) {
        violations.push('preset: missing @deepseek-ai/dsh-agent-preset row (mode-picker entry)')
      } else {
        const cfg = preset.config ?? {}
        for (const key of ['id', 'name', 'description', 'order', 'plugins']) {
          if (!(key in cfg)) violations.push(`preset: config.${key} is required`)
        }
        const plugins = cfg.plugins ?? []
        if (!plugins.some((p) => p.id === 'persona')) violations.push('preset: persona plugin row is required')
        const persona = plugins.find((p) => p.id === 'persona')
        if (persona?.config?.prefix == null) violations.push('preset: persona must declare config.prefix (full orchestration prompt)')
        if (persona?.config?.complete === true) {
          violations.push('preset: persona must NOT set complete:true (autoflow needs the default tool surface; use prefix-style like the redteam preset)')
        }
        // The preset must carry the development tool surface (dev tasks need real tools).
        // Tools may live inside cordis:group rows whose config is an array of rows,
        // so walk both the top-level plugin list and each group's row array.
        const collectNames = (rows, acc = []) => {
          for (const row of rows ?? []) {
            if (row && typeof row === 'object' && typeof row.name === 'string') acc.push(row.name)
            if (row && typeof row === 'object' && Array.isArray(row.config)) collectNames(row.config, acc)
          }
          return acc
        }
        const toolNames = new Set(collectNames(plugins))
        const requiredToolRows = [
          '@deepseek-ai/dsh-tool-fs',
          '@deepseek-ai/dsh-tool-todo',
          '@deepseek-ai/dsh-tool-web',
          '@deepseek-ai/dsh-tool-subagent',
        ]
        for (const t of requiredToolRows) {
          if (!toolNames.has(t)) violations.push(`preset: missing tool row ${t} (dev execution capability)`)
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log('PASS: dsh-dev-autoflow complies with DSH Plugin Standard v2.0 static gates')
    process.exit(0)
  }
  console.error('FAIL: MUST violations found:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

main().catch((e) => {
  console.error('FAIL:', e instanceof Error ? e.message : String(e))
  process.exit(2)
})
