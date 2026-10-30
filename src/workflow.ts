/**
 * dsh-dev-autoflow — core pipeline logic.
 *
 * Reimplements the dev-autoflow skill as deterministic, host-side code so the
 * visual window can drive real execution instead of static mockups:
 *
 *   1. refineRequirement()  — turn a raw request into a structured spec draft.
 *   2. runSpecCheck()       — structural gate + scripts/spec_check.py hard gate.
 *   3. routeChannel()       — pick the execution channel by deliverable × scope.
 *   4. case library         — load / append records (markdown, injection-safe).
 *
 * Design rules enforced here (see CODE_REVIEW.md):
 *   - A validator failure is a FAIL, never a silent PASS. Environment problems
 *     are reported as `degraded`, which callers must surface differently.
 *   - Every path is resolved against the package root, never process.cwd().
 *   - User data (case library) lives outside the package directory.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ---------------- types ---------------- */

export interface RequirementSpec {
  goal: string
  audience: string
  deliverable: string
  features: string[]
  boundaries: string[]
  constraints: string[]
  acceptance: string[]
  costNote: string
  openQuestions: string[]
  /**
   * Fields that were filled by the refiner rather than stated by the user.
   * Anything here is an assumption and must be surfaced to the user.
   */
  inferred?: string[]
}

export interface SpecCheckResult {
  ok: boolean
  problems: string[]
  /**
   * True when the deterministic python gate could not run (missing runtime /
   * timeout). `ok` then reflects the structural gate only — callers must show
   * this as "soft pass", never as a clean PASS.
   */
  degraded?: boolean
}

export type Channel =
  | { kind: 'direct'; reason: string }
  | { kind: 'skill'; skill: string; reason: string }
  | { kind: 'organize'; reason: string }
  | { kind: 'explore'; reason: string }

export interface CaseRecord {
  id: number
  date: string
  summary: string
  channel: string
  deliverable: string
  result: string
  lesson: string
}

export interface PipelineResult {
  spec: RequirementSpec
  check: SpecCheckResult
  channel: Channel
  cases: CaseRecord[]
  /** Fields the refiner filled in rather than read from the request. */
  inferred: string[]
  /** Questions whose answer would materially change the plan. */
  questions: string[]
}

export interface SpecArgs {
  deliverable: string
  goal: string
  features: string[]
  audience: string
  boundaries: string[]
  constraints: string[]
  acceptance: string[]
  costNote: string
  openQuestions: string[]
}

/** Structural shape accepted by routeChannel (used by the host tool adapter). */
export type RoutableSpec = Pick<RequirementSpec, 'deliverable' | 'goal' | 'features'>

/* ---------------- package / data locations ---------------- */

/**
 * Locate the plugin package root. Works both from source (`src/workflow.ts`)
 * and from the bundle (`index.js` at the root), so tests and the installed
 * plugin resolve identically.
 */
export function findPackageRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'cordis.patch.yml'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return start
}

export const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)))

/** Bundled deterministic validator. */
export const DEFAULT_SPEC_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'spec_check.py')

/** Legacy in-package case library (migrated once into the user data dir). */
export const LEGACY_CASE_FILE = join(PACKAGE_ROOT, 'references', 'case-library.md')

/** User data directory for the case library. */
export function defaultDataDir(): string {
  const fromEnv = process.env.DSH_AUTOFLOW_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh', 'autoflow')
}

export function defaultCaseFile(): string {
  return join(defaultDataDir(), 'cases.md')
}

/** Resolve a configured path: absolute stays, relative is package-root based. */
export function resolveConfigPath(path: string): string {
  return /^([a-zA-Z]:[\\/]|\/)/.test(path) ? resolve(path) : resolve(PACKAGE_ROOT, path)
}

/* ---------------- spec parsing ---------------- */

const FIELD_ALIASES: Record<string, string> = {
  目标: '目标',
  受众: '受众',
  '受众/使用场景': '受众',
  使用场景: '受众',
  交付形态: '交付形态',
  核心功能: '核心功能',
  功能: '核心功能',
  范围边界: '范围边界',
  不做: '范围边界',
  技术约束: '技术约束',
  验收标准: '验收标准',
  成本预算: '成本预算',
  待确认项: '待确认项',
}

export const REQUIRED_FIELDS = ['目标', '受众', '交付形态', '核心功能', '范围边界', '技术约束', '验收标准']

/** Verbs / units that make an acceptance line objectively checkable. */
const TESTABLE = new RegExp(
  [
    '能', '可', '打开', '运行', '显示', '展示', '返回', '输出', '刷新', '生成', '解析',
    '通过', '达到', '不超过', '不少于', '大于', '小于', '等于', '跑通', '渲染', '点击',
    '切换', '提交', '保存', '下载', '导出', '导入', '测试', '校验',
    '\\d+\\s*(?:ms|s|秒|分钟|条|个|项|%|px|行)',
    'pass', 'fail', 'verify',
  ].join('|'),
  'i',
)

/** Split a field value into list items (numbered / bulleted / bare lines). */
export function listItems(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/^(?:\d+[.)、]|[-*•])\s*/, '').trim())
    .filter((line) => line !== '')
}

/**
 * Parse a spec into normalized fields.
 *
 * Accepts both the canonical `【字段】值` contract and the looser forms models
 * actually produce (`## 目标`, `**目标**：`, `目标：`), so a good spec is never
 * rejected just because of formatting.
 */
export function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const push = (rawName: string, value: string): void => {
    const name = FIELD_ALIASES[rawName.trim()] ?? rawName.trim()
    const next = value.trim()
    fields[name] = fields[name] ? `${fields[name]}\n${next}` : next
  }

  const bracket = [...text.matchAll(/【([^】\n]+)】/g)]
  if (bracket.length > 0) {
    bracket.forEach((match, index) => {
      const start = (match.index ?? 0) + match[0].length
      const end = index + 1 < bracket.length ? (bracket[index + 1].index ?? text.length) : text.length
      push(match[1], text.slice(start, end))
    })
    return fields
  }

  // Fallback: markdown headings / bold labels / "名称：" lines.
  let current: string | null = null
  let buffer: string[] = []
  const flush = (): void => {
    if (current !== null) push(current, buffer.join('\n'))
    current = null
    buffer = []
  }
  for (const line of text.split(/\r?\n/)) {
    const inline = line.match(/^\s*(?:#{1,6}\s*)?\*{0,2}([\u4e00-\u9fa5A-Za-z/]{1,12})\*{0,2}\s*[:：]\s*(.*)$/)
    const heading = line.match(/^\s*#{1,6}\s*([\u4e00-\u9fa5A-Za-z/]{1,12})\s*$/)
    const match = inline ?? heading
    if (match) {
      flush()
      current = match[1]
      buffer = match[2] !== undefined && match[2].trim() !== '' ? [match[2]] : []
    } else if (current !== null) {
      buffer.push(line)
    }
  }
  flush()
  return fields
}

/* ---------------- spec refinement ---------------- */

/** Deliverable detection, most specific first. Labels are routeChannel-friendly. */
const DELIVERABLE_RULES: { test: RegExp; label: string }[] = [
  { test: /静态网页|静态页|纯静态|单页应用|落地页/, label: '网页（静态）' },
  { test: /看板|仪表盘|dashboard/i, label: '网页（看板）' },
  { test: /小程序/, label: '微信小程序' },
  { test: /网页|网站|官网|h5/i, label: '网页' },
  { test: /web\s*应用|应用|系统|平台|后台|管理端/i, label: 'Web 应用' },
  { test: /脚本|命令行|cli|批处理/i, label: '脚本' },
  { test: /表格|excel|csv|xlsx|电子表/i, label: '表格' },
  { test: /ppt|幻灯片|演示文稿|slides?/i, label: 'PPT' },
  { test: /文档|报告|合同|word/i, label: '文档' },
  { test: /图片|海报|封面|设计稿/, label: '图片' },
  { test: /视频|短片|动画/, label: '视频' },
]

/** Clauses that describe an actual capability rather than context. */
const FEATURE_CUE = /能|可以|要|需要|支持|看到|查看|显示|统计|导出|导入|筛选|搜索|上传|下载|排序|计算|生成|预览|切换|登录|提醒|图表|对比|汇总/

/** Clauses already consumed by another field. */
const NOT_A_FEATURE = /^(?:受众|用户|面向|给|不做|不包含|排除|技术|用|基于|数据来自|数据源|部署)/

function detectDeliverable(raw: string): string {
  for (const rule of DELIVERABLE_RULES) {
    if (rule.test.test(raw)) return rule.label
  }
  return ''
}

function defaultAudience(deliverable: string): string {
  if (/网页|小程序|应用/.test(deliverable)) return '浏览器用户'
  if (/表格/.test(deliverable)) return '数据分析人员'
  if (/脚本/.test(deliverable)) return '命令行使用者'
  if (/PPT|文档/.test(deliverable)) return '汇报受众'
  if (/图片/.test(deliverable)) return '运营/品牌'
  if (/视频/.test(deliverable)) return '内容受众'
  return '通用用户'
}

function cleanClause(text: string): string {
  return text
    .replace(/^[\s，,。；;、]+/, '')
    .replace(/^(?:并且|而且|同时|还|也|要|需要|能|可以|支持|希望|最好)+/, '')
    .replace(/[\s，,。；;、]+$/, '')
    .trim()
}

/** Derive one testable acceptance line from a feature phrase. */
function acceptanceFor(feature: string, deliverable: string): string {
  if (/导出|下载/.test(feature)) return `点击导出能下载「${feature}」`
  if (/上传|导入/.test(feature)) return `选择文件上传后能看到处理结果`
  if (/脚本/.test(deliverable)) {
    return /统计|计算|汇总|生成|处理/.test(feature)
      ? `运行脚本后能输出「${feature}」的结果`
      : `运行脚本后能完成「${feature}」`
  }
  if (/PPT|文档/.test(deliverable)) return `交付文档中包含${feature}`
  if (/表格/.test(deliverable)) return `表格中能看到${feature}`
  if (/^(?:看到|查看|显示|展示)/.test(feature)) return `打开后可${feature}`
  if (/统计|图表|汇总|对比/.test(feature)) return `打开后可看到${feature}`
  if (/筛选|搜索|切换|排序/.test(feature)) return `操作「${feature}」后结果刷新`
  if (/计算|生成/.test(feature)) return `运行后能输出「${feature}」的结果`
  return `能完成「${feature}」`
}

const DEFAULT_BOUNDARY = '按最小实现：不做登录/权限，不做后端与数据库，不做移动端适配'

/** Constraint default that fits the deliverable instead of one blanket sentence. */
function defaultConstraint(deliverable: string): string {
  if (/PPT|文档/.test(deliverable)) return '未指定，按默认（标准模板、无品牌规范）'
  if (/表格/.test(deliverable)) return '未指定，按默认（单文件表格、公式可复核）'
  if (/图片|视频/.test(deliverable)) return '未指定，按默认（单份素材、不使用第三方版权素材）'
  return '未指定，按默认（静态单文件、无外部依赖）'
}

/**
 * Deterministic requirement refinement.
 *
 * Parses the raw ask into the spec contract: what can be read from the text is
 * taken as stated, what cannot is filled with a documented default and listed
 * in `inferred` (and therefore in `openQuestions`). Nothing is invented
 * silently — but nothing that *can* be inferred is left blank either, so the
 * hard gate has something real to judge.
 *
 * This is rule-based, not an LLM rewrite: a request with no discernible
 * capability still fails the gate, which is the honest outcome.
 */
export function refineRequirement(raw: string): RequirementSpec {
  const text = String(raw ?? '').trim()
  const inferred: string[] = []
  const openQuestions: string[] = []

  const clauses = text
    .split(/[。；;\n]/)
    .flatMap((part) => part.split(/[，,]/))
    .map((part) => part.trim())
    .filter((part) => part !== '')

  const goalSource = clauses[0] ?? text
  const goal =
    cleanClause(goalSource)
      .replace(/^(?:帮我|帮忙|请|麻烦|我想|我要|想)+/, '')
      .trim()
      .slice(0, 120) || text.slice(0, 120)

  // ── deliverable ──────────────────────────────────────────────────────────
  let deliverable = detectDeliverable(text)
  if (deliverable === '') {
    if (/统计|展示|看|浏览|界面|页面/.test(text)) deliverable = '网页（静态）'
    else if (/计算|处理|批处理/.test(text)) deliverable = '脚本'
    else deliverable = '未指定（按路由判定）'
    inferred.push('交付形态')
    openQuestions.push('期望的交付形态是什么（网页/脚本/表格/文档/工程代码）？')
  }

  // ── audience ─────────────────────────────────────────────────────────────
  let audience = text.match(/受众(?:是|为)?\s*[：:]?\s*([^\s，,。；;]+)/)?.[1]
    ?? text.match(/(?:面向|给)\s*([^\s，,。；;]{2,12}?)\s*(?:用|看|使用)/)?.[1]
    ?? ''
  if (audience === '') {
    audience = defaultAudience(deliverable)
    inferred.push('受众')
    openQuestions.push(`目标受众默认按「${audience}」处理，是否正确？`)
  }

  // ── boundaries ───────────────────────────────────────────────────────────
  const boundaries: string[] = []
  for (const match of text.matchAll(/不做\s*([^。；;，,\n]+)/g)) {
    const item = match[1].trim()
    if (item !== '') boundaries.push(`不做${item}`)
  }
  for (const match of text.matchAll(/(?:不包含|排除)\s*([^。；;，,\n]+)/g)) {
    const item = match[1].trim()
    if (item !== '') boundaries.push(`不包含${item}`)
  }
  if (boundaries.length === 0) {
    boundaries.push(DEFAULT_BOUNDARY)
    inferred.push('范围边界')
    openQuestions.push('默认按最小实现收敛范围（不做登录、不做后端、不做移动端适配），需要放开哪一项？')
  }

  // ── constraints ──────────────────────────────────────────────────────────
  const constraints: string[] = []
  const explicitConstraint = text.match(/(?:技术(?:约束|栈)?|技术方案)\s*[：:]?\s*([^。；;\n]+)/)?.[1]
  if (explicitConstraint !== undefined) constraints.push(cleanClause(explicitConstraint))
  const tooling = text.match(/(?:用|基于)\s*([^，,。；;\n]{2,20}?)\s*(?:做|实现|写|开发)/)?.[1]
  if (tooling !== undefined) constraints.push(`使用 ${cleanClause(tooling)}`)
  for (const match of text.matchAll(/(纯前端|无后端|离线|本地运行|单文件|不联网)/g)) constraints.push(match[1])
  const dataSource = text.match(/数据(?:来自|来源)\s*([^，,。；;\n]+)/)?.[1]
  if (dataSource !== undefined) constraints.push(`数据来自 ${cleanClause(dataSource)}`)
  if (constraints.length === 0) {
    constraints.push(defaultConstraint(deliverable))
    inferred.push('技术约束')
  }

  // ── features ─────────────────────────────────────────────────────────────
  const features: string[] = []
  for (const clause of clauses) {
    if (NOT_A_FEATURE.test(clause)) continue
    if (!FEATURE_CUE.test(clause)) continue
    const feature = cleanClause(clause)
    if (feature.length < 2) continue
    if (features.some((item) => item === feature || item.includes(feature))) continue
    features.push(feature)
    if (features.length >= 8) break
  }
  if (features.length === 0) {
    openQuestions.push('这个需求必须做到哪几件事？请列出 2~5 条核心功能。')
  }

  // ── acceptance ───────────────────────────────────────────────────────────
  const acceptance = features.map((feature) => acceptanceFor(feature, deliverable))
  if (acceptance.length > 0) inferred.push('验收标准（按核心功能推导）')

  return {
    goal,
    audience,
    deliverable,
    features,
    boundaries,
    constraints,
    acceptance,
    costNote: '未估计',
    openQuestions,
    inferred,
  }
}

/* ---------------- hard validation ---------------- */

interface ProcessOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Spawn a process, feed `input` on stdin, collect output, honour a timeout. */
function runProcess(bin: string, args: string[], input: string, timeoutMs: number): Promise<ProcessOutcome> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut })
    }

    const child = spawn(bin, args, { windowsHide: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      finish(null)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => {
      stderr += String(error.message)
      finish(null)
    })
    child.on('close', (code) => finish(code))
    child.stdin?.on('error', () => {
      /* the child may exit before reading stdin; not fatal */
    })
    child.stdin?.end(input, 'utf8')
  })
}

/** Parse `FAIL:` blocks printed by scripts/spec_check.py. */
export function parseCheckerOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== '')
}

let cachedInterpreter: string | null | undefined

/** Probe python interpreters once; `undefined` = not probed yet, `null` = none. */
async function detectInterpreter(): Promise<string | null> {
  if (cachedInterpreter !== undefined) return cachedInterpreter
  const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
  for (const bin of candidates) {
    const outcome = await runProcess(bin, ['--version'], '', 5000)
    if (outcome.code === 0 && /python/i.test(`${outcome.stdout}${outcome.stderr}`)) {
      cachedInterpreter = bin
      return bin
    }
  }
  cachedInterpreter = null
  return null
}

/** Test seam: reset the cached interpreter probe. */
export function resetInterpreterCache(): void {
  cachedInterpreter = undefined
}

/**
 * Run the hard gate: structural check first (zero-dependency), then the
 * deterministic python validator.
 *
 * Exit code 1 means "the spec failed validation" — that is a real FAIL and is
 * returned as `ok: false`. Only a missing/broken runtime degrades to
 * `degraded: true`, and callers must not render that as a clean pass.
 */
export async function runSpecCheck(
  specText: string,
  scriptPath = DEFAULT_SPEC_SCRIPT,
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<SpecCheckResult> {
  const structural = structuralCheck(specText)
  if (!structural.ok) return structural

  const bin = opts.bin ?? (await detectInterpreter())
  if (bin === null) {
    return { ok: true, degraded: true, problems: ['未找到 python 解释器，仅通过结构检查（degraded）'] }
  }

  const outcome = await runProcess(bin, [scriptPath, '-'], specText, opts.timeoutMs ?? 15000)
  if (outcome.code === 0) return { ok: true, problems: [] }
  if (outcome.code === 1) {
    const problems = parseCheckerOutput(`${outcome.stdout}\n${outcome.stderr}`)
    return { ok: false, problems: problems.length > 0 ? problems : ['规格校验未通过（校验器未给出明细）'] }
  }
  const reason = outcome.timedOut
    ? '校验器超时'
    : `校验器无法执行（${outcome.stderr.trim().slice(0, 80) || 'unknown error'}）`
  return { ok: true, degraded: true, problems: [`${reason}，仅通过结构检查（degraded）`] }
}

/**
 * Zero-dependency structural gate: required fields present **and non-empty**,
 * boundaries declare what is out of scope, acceptance criteria testable.
 */
export function structuralCheck(text: string): SpecCheckResult {
  const problems: string[] = []
  const fields = parseFields(text)

  for (const field of REQUIRED_FIELDS) {
    if ((fields[field] ?? '').trim() === '') problems.push(`缺少或为空: 【${field}】`)
  }

  const boundary = (fields['范围边界'] ?? '').trim()
  if (boundary !== '') {
    const declaresOutOfScope = /不做|不包含|不支持|不涉及|排除/.test(boundary)
    const isPlaceholder = /^(暂无|无|待定|未声明|略)$/.test(boundary)
    if (!declaresOutOfScope || isPlaceholder) {
      problems.push('【范围边界】未声明"不做"的内容（写"无/暂无"不算声明，请明确排除项）')
    }
  }

  const features = listItems(fields['核心功能'] ?? '')
  const accepts = listItems(fields['验收标准'] ?? '')
  if (accepts.length > 0) {
    if (features.length > 0 && accepts.length < features.length) {
      problems.push(`验收标准(${accepts.length}条)少于核心功能(${features.length}条)：每条功能都应有对应验收标准`)
    }
    for (const line of accepts) {
      if (!TESTABLE.test(line)) problems.push(`验收标准不可测(缺可验证动词): ${line.slice(0, 60)}`)
    }
  }

  return { ok: problems.length === 0, problems }
}

/* ---------------- channel routing ---------------- */

interface RouteRule {
  test: RegExp
  channel: () => Channel
}

const ROUTE_RULES: RouteRule[] = [
  {
    test: /单页|静态|展示|看板|可视化报告|落地页|官网|dashboard|landing/,
    channel: () => ({ kind: 'skill', skill: 'html / doubao-visualization', reason: '静态展示型页面走 html，快且省' }),
  },
  {
    test: /应用|系统|平台|webapp|全栈|管理后台|数据库|登录/,
    channel: () => ({ kind: 'skill', skill: 'doubao-app-builder (webapp)', reason: '多文件工程走 app-builder' }),
  },
  {
    test: /表格|excel|csv|xlsx|数据|分析|sheet/,
    channel: () => ({ kind: 'skill', skill: 'sheet / doubao-data-analysis', reason: '表格与数据分析有专有 skill' }),
  },
  {
    test: /文档|doc|word|报告|合同/,
    channel: () => ({ kind: 'skill', skill: 'word / lark-doc / doubao-contract-drafting', reason: '文档类走专有 skill' }),
  },
  {
    test: /ppt|幻灯片|slide|演示/,
    channel: () => ({ kind: 'skill', skill: 'ppt', reason: '幻灯片全流程' }),
  },
  {
    test: /图片|海报|设计|视觉|logo/,
    channel: () => ({ kind: 'skill', skill: 'doubao-creative-design', reason: '视觉创作有专有流程' }),
  },
  {
    test: /视频|短片|动画/,
    channel: () => ({ kind: 'skill', skill: 'doubao-creative-video', reason: '视频创作有专有流程' }),
  },
]

/**
 * Route a spec to the cheapest channel that still meets quality.
 *
 * Routing depends only on the spec (deliverable × goal × feature count). The
 * size of the case library must never change the answer.
 *
 * @param spec routable spec (deliverable / goal / features)
 * @param featureCount optional explicit count; defaults to `spec.features.length`
 */
export function routeChannel(spec: RoutableSpec, featureCount?: number): Channel {
  const deliverable = (spec.deliverable ?? '').toLowerCase()
  const goal = (spec.goal ?? '').toLowerCase()
  const features = typeof featureCount === 'number' ? Math.max(0, featureCount) : (spec.features?.length ?? 0)

  // Multi-channel / large-scope signals take precedence over deliverable-type
  // routing: a deep multi-source comparison must be delegated even when the
  // deliverable happens to be a report or document.
  const multiSignal = /调研|对比|多通道|多平台|系统分析|深度|全面|竞品|多场景|research|compare/.test(goal)
  if (multiSignal && features >= 3) {
    return { kind: 'organize', reason: '多通道/多场景信号 + 功能拆解 ≥3，委派 OrganizeAgent 并行' }
  }

  for (const rule of ROUTE_RULES) {
    if (rule.test.test(deliverable)) return rule.channel()
  }

  return { kind: 'direct', reason: '单文件/单任务，MainAgent 直接执行最省成本' }
}

/* ---------------- case library ---------------- */

const CASE_HEADER = '# 任务经验沉淀库\n\n'
const CASE_HEADING = /^### 案例 (\d+)：([^\n]*)$/gm

/** Collapse a value into a single safe markdown line. */
export function sanitizeField(value: unknown, maxLen = 300): string {
  return String(value ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/[#`*>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

/** Load case records from the markdown library (id taken from the heading). */
export async function loadCases(caseFile: string): Promise<CaseRecord[]> {
  try {
    const text = await readFile(caseFile, 'utf8')
    const heads: { id: number; summary: string; start: number; end: number }[] = []
    CASE_HEADING.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = CASE_HEADING.exec(text)) !== null) {
      heads.push({
        id: Number(match[1]),
        summary: match[2].trim(),
        start: match.index,
        end: match.index + match[0].length,
      })
    }
    return heads.map((head, index) => {
      const block = text.slice(head.end, index + 1 < heads.length ? heads[index + 1].start : text.length)
      const field = (label: string): string => block.match(new RegExp(`${label}：(.+)`))?.[1]?.trim() ?? ''
      return {
        id: head.id,
        date: field('日期'),
        summary: head.summary,
        channel: field('执行通道'),
        deliverable: field('交付形态'),
        result: field('结果'),
        lesson: field('教训'),
      }
    })
  } catch {
    return []
  }
}

/** Append a case record to the markdown library (injection-safe, id-monotonic). */
export async function appendCase(caseFile: string, record: Omit<CaseRecord, 'id'>): Promise<CaseRecord> {
  const records = await loadCases(caseFile)
  const nextId = records.reduce((max, item) => Math.max(max, Number.isFinite(item.id) ? item.id : 0), 0) + 1

  const clean: Omit<CaseRecord, 'id'> = {
    date: sanitizeField(record.date, 20),
    summary: sanitizeField(record.summary, 160),
    channel: sanitizeField(record.channel, 60),
    deliverable: sanitizeField(record.deliverable, 60),
    result: sanitizeField(record.result, 120),
    lesson: sanitizeField(record.lesson, 240),
  }
  if (clean.summary === '') throw new Error('summary 不能为空')

  const entry = [
    `### 案例 ${nextId}：${clean.summary}`,
    `- 日期：${clean.date}`,
    `- 需求要点：${clean.summary}`,
    `- 执行通道：${clean.channel}`,
    `- 交付形态：${clean.deliverable}`,
    `- 结果：${clean.result}`,
    `- 教训：${clean.lesson}`,
    '',
    '',
  ].join('\n')

  await mkdir(dirname(resolve(caseFile)), { recursive: true })
  let needsHeader = false
  try {
    needsHeader = (await stat(caseFile)).size === 0
  } catch {
    needsHeader = true
  }
  await appendFile(caseFile, (needsHeader ? CASE_HEADER : '') + entry, 'utf8')
  return { id: nextId, ...clean }
}

/**
 * Make sure the case library exists, migrating a legacy in-package library on
 * first run so upgrading the plugin never silently drops accumulated cases.
 */
export async function ensureCaseFile(caseFile: string, legacyFile?: string): Promise<string> {
  try {
    await access(caseFile)
    return caseFile
  } catch {
    /* not created yet */
  }
  if (legacyFile !== undefined) {
    try {
      const legacy = await readFile(legacyFile, 'utf8')
      if (/### 案例 \d+：/.test(legacy)) {
        await mkdir(dirname(resolve(caseFile)), { recursive: true })
        await writeFile(caseFile, legacy, 'utf8')
      }
    } catch {
      /* no legacy library */
    }
  }
  return caseFile
}

/* ---------------- pipeline ---------------- */

/** Build the canonical spec text contract used by both gates. */
export function buildSpecText(spec: RequirementSpec): string {
  return [
    `【目标】${spec.goal}`,
    `【受众】${spec.audience}`,
    `【交付形态】${spec.deliverable}`,
    `【核心功能】${spec.features.map((f, i) => `\n${i + 1}. ${f}`).join('')}`,
    `【范围边界】${spec.boundaries.join('；')}`,
    `【技术约束】${spec.constraints.join('；')}`,
    `【验收标准】${spec.acceptance.map((a, i) => `\n${i + 1}. ${a}`).join('')}`,
    `【成本预算】${spec.costNote}`,
    `【待确认项】${spec.openQuestions.join('；')}`,
  ].join('\n')
}

/**
 * Run the full pipeline in one call: refine → hard gate → route.
 *
 * The refiner is deterministic (rule-based extraction + documented defaults),
 * so `check.ok` is a real judgement on the refined spec. When the request has
 * no discernible capability the gate fails, and `questions` says what is
 * missing — that is the honest outcome, not a bug.
 */
export async function runPipeline(
  raw: string,
  opts: { specScript?: string; caseFile?: string } = {},
): Promise<PipelineResult> {
  const spec = refineRequirement(raw)
  const caseFile = resolve(opts.caseFile ?? defaultCaseFile())
  const cases = await loadCases(caseFile)
  const channel = routeChannel(spec, spec.features.length)
  const check = await runSpecCheck(buildSpecText(spec), opts.specScript ? resolve(opts.specScript) : DEFAULT_SPEC_SCRIPT)
  return {
    spec,
    check,
    channel,
    cases,
    inferred: spec.inferred ?? [],
    questions: spec.openQuestions,
  }
}
