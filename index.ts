/**
 * dsh-dev-autoflow — host half.
 *
 * Declares the "自动流" agent preset's tool surface (registered via ctx.tools)
 * and a same-origin JSON API on the DSH webServer:
 *
 *   GET    /api/autoflow/state             -> aggregated progress + cases (client polls this)
 *   GET    /api/autoflow/status            -> alias of /state (kept for compatibility)
 *   GET    /api/autoflow/progress          -> last pipeline run's per-step state
 *   POST   /api/autoflow/run               -> { raw: string } spec draft + gates + route
 *   GET    /api/autoflow/cases             -> case library records
 *   POST   /api/autoflow/cases             -> { record } append a case
 *
 * Agent tools (callable in chat under the 自动流 mode):
 *   autoflow_spec_check   — hard-validate a requirement spec
 *   autoflow_route        — recommend an execution channel
 *   autoflow_report_step  — report real progress of a pipeline step
 *   autoflow_append_case  — persist a case to the experience library
 *
 * Progress is keyed per session (the tool run context carries the agent id) so
 * concurrent conversations never overwrite each other's step board.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  appendCase,
  DEFAULT_SPEC_SCRIPT,
  defaultCaseFile,
  ensureCaseFile,
  LEGACY_CASE_FILE,
  loadCases,
  resolveConfigPath,
  routeChannel,
  runPipeline,
  runSpecCheck,
  type CaseRecord,
  type Channel,
  type PipelineResult,
} from './src/workflow.js'

export const name = 'dsh-dev-autoflow'
export const inject = ['webServer', 'tools']

export interface Config {
  /** Path to scripts/spec_check.py. Relative paths resolve against the package root. */
  specScript?: string
  /** Path to the case library markdown. Defaults to `<data dir>/cases.md`. */
  caseFile?: string
}

/* ---------------- progress state (per session) ---------------- */

export type StepStatus = 'pending' | 'active' | 'done' | 'fail' | 'skipped'

export interface StepState {
  key: string
  label: string
  status: StepStatus
  note: string
  updatedAt: number
}

interface ProgressState {
  active: boolean
  steps: StepState[]
  updatedAt: number
}

const PIPELINE_STEPS = [
  { key: 'spec', label: '需求重构' },
  { key: 'check', label: '规格硬校验' },
  { key: 'route', label: '通道路由' },
  { key: 'execute', label: '执行验证' },
  { key: 'case', label: '案例沉淀' },
] as const

const progressBySession = new Map<string, ProgressState>()
let lastSessionKey = 'default'

function makeSteps(): StepState[] {
  return PIPELINE_STEPS.map((step) => ({
    key: step.key,
    label: step.label,
    status: 'pending' as StepStatus,
    note: '',
    updatedAt: 0,
  }))
}

function stateOf(sessionKey: string): ProgressState {
  let state = progressBySession.get(sessionKey)
  if (state === undefined) {
    state = { active: false, steps: makeSteps(), updatedAt: 0 }
    progressBySession.set(sessionKey, state)
    if (progressBySession.size > 32) {
      const oldest = [...progressBySession.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
      if (oldest !== undefined) progressBySession.delete(oldest[0])
    }
  }
  return state
}

/** Reset the progress board for a new run in one session. */
export function resetProgress(sessionKey = 'default'): void {
  lastSessionKey = sessionKey
  progressBySession.set(sessionKey, { active: true, steps: makeSteps(), updatedAt: Date.now() })
}

/** Start a run only when this session has none in flight (keeps retries intact). */
function ensureRun(sessionKey: string): void {
  if (!stateOf(sessionKey).active) resetProgress(sessionKey)
}

/** Mark a step's state. `note` is only replaced when provided. */
export function setStepState(sessionKey: string, key: string, status: StepStatus, note?: string): void {
  const state = stateOf(sessionKey)
  const step = state.steps.find((item) => item.key === key)
  if (step === undefined) return
  step.status = status
  if (note !== undefined) step.note = note
  step.updatedAt = Date.now()
  state.updatedAt = Date.now()
}

/**
 * Close a run: in-flight steps settle to done (or fail), and untouched steps
 * stay `pending`. Nothing is ever reported as done that was not actually run.
 */
export function finishProgress(sessionKey: string, failed = false): void {
  const state = stateOf(sessionKey)
  state.active = false
  for (const step of state.steps) {
    if (step.status === 'active') {
      step.status = failed ? 'fail' : 'done'
      step.updatedAt = Date.now()
    }
  }
  state.updatedAt = Date.now()
}

export function currentProgress(sessionKey = lastSessionKey): { active: boolean; steps: StepState[] } {
  const state = stateOf(sessionKey)
  return { active: state.active, steps: state.steps.map((step) => ({ ...step })) }
}

/* ---------------- minimal structural host context ---------------- */

interface HostContext {
  webServer?: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    }): () => void
  }
  tools?: {
    register(tool: unknown): unknown
  }
  effect?(callback: () => unknown, label?: string): unknown
  logger?: { info?(message: string): void; warn(message: string): void }
}

/** Resolve the session key from a tool run context (agent id) or the API query. */
function sessionOf(exec: unknown): string {
  const agent = (exec as { agent?: { id?: unknown } } | undefined)?.agent
  const id = agent?.id
  return typeof id === 'string' && id !== '' ? id : 'default'
}

export function apply(ctx: HostContext, config?: Config): void {
  const specScript = config?.specScript === undefined ? DEFAULT_SPEC_SCRIPT : resolveConfigPath(config.specScript)
  const caseFile = config?.caseFile === undefined ? defaultCaseFile() : resolveConfigPath(config.caseFile)

  // Migrate the legacy in-package library only when the user did not point at a
  // custom file (their own file must never be seeded with someone else's data).
  if (config?.caseFile === undefined) {
    void ensureCaseFile(caseFile, LEGACY_CASE_FILE).catch(() => undefined)
  }

  // Agent tools — callable in chat under the 自动流 mode.
  ctx.tools?.register?.(defineTool({
    name: 'autoflow_spec_check',
    description: '开发自动流：对需求规格文本做硬校验（必填字段齐全且非空、验收标准可测、范围边界声明"不做"）。返回 PASS/FAIL 与问题清单；校验器不可用时返回 degraded。规格定稿前调用一次。',
    parameters: {
      spec: { type: 'string', description: '规格文本，含【目标】【受众】【交付形态】【核心功能】【范围边界】【技术约束】【验收标准】等字段。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true, description: '校验是否通过。' },
          problems: { type: 'array', required: true, items: { type: 'string' }, description: '未通过时的问题清单。' },
          degraded: { type: 'boolean', description: '确定性校验器不可用，仅通过结构检查。' },
        },
        additionalProperties: false,
      },
      render: (_args, value: { ok: boolean; problems: string[]; degraded?: boolean }) => [
        {
          type: 'text',
          text: value.ok
            ? (value.degraded === true
              ? `规格仅通过结构检查（确定性校验器不可用，降级为软通过）\n${value.problems.map((p) => `- ${p}`).join('\n')}`
              : '规格硬校验通过 ✓（必填字段齐全且非空、验收标准可测、范围边界已声明）')
            : `规格硬校验未通过 ✗\n${value.problems.map((p) => `- ${p}`).join('\n')}`,
        },
      ],
    },
    execute: async (args: { spec?: string }, exec: { agent?: { id?: unknown } }) => {
      const session = sessionOf(exec)
      const text = typeof args?.spec === 'string' && args.spec.trim() !== '' ? args.spec : ''
      if (text === '') {
        ensureRun(session)
        setStepState(session, 'check', 'fail', '缺少规格文本')
        return { ok: false, problems: ['缺少规格文本（spec 参数为空）'] }
      }
      ensureRun(session)
      setStepState(session, 'check', 'active', '正在硬校验规格…')
      const check = await runSpecCheck(text, specScript)
      if (check.ok) {
        setStepState(session, 'check', 'done', check.degraded === true ? '结构检查通过（校验器不可用）' : '规格硬校验通过')
        setStepState(session, 'spec', 'done', '需求重构完成')
      } else {
        setStepState(session, 'check', 'fail', check.problems[0] ?? '规格校验失败')
      }
      return { ok: check.ok, problems: check.problems, degraded: check.degraded === true }
    },
  }))

  ctx.tools?.register?.(defineTool({
    name: 'autoflow_route',
    description: '开发自动流：根据需求规格推荐执行通道（direct=直接执行 / skill=加载本地 skill / organize=委派 OrganizeAgent）。按交付形态与规模×复杂度判定，返回通道与理由。',
    parameters: {
      deliverable: { type: 'string', description: '交付形态，如：网页/脚本/表格/文档/PPT/工程代码/报告。' },
      goal: { type: 'string', description: '一句话目标描述。' },
      featureCount: { type: 'number', description: '核心功能条数（3~8 条为典型）。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', required: true, enum: ['direct', 'skill', 'organize', 'explore'], description: '推荐通道。' },
          skill: { type: 'string', description: 'channel=skill 时的 skill 名。' },
          reason: { type: 'string', required: true, description: '路由理由。' },
        },
        additionalProperties: false,
      },
      render: (_args, value: { channel: string; skill?: string; reason: string }) => [
        {
          type: 'text',
          text: `推荐执行通道：${value.channel}${value.skill ? `（${value.skill}）` : ''}\n理由：${value.reason}`,
        },
      ],
    },
    execute: async (args: { deliverable?: string; goal?: string; featureCount?: number }, exec: { agent?: { id?: unknown } }) => {
      const session = sessionOf(exec)
      const spec = {
        deliverable: typeof args?.deliverable === 'string' ? args.deliverable : '未指定',
        goal: typeof args?.goal === 'string' ? args.goal : '',
        features: [] as string[],
      }
      const featureCount = Number.isFinite(args?.featureCount) ? Number(args?.featureCount) : undefined
      const channel = routeChannel(spec, featureCount)
      ensureRun(session)
      setStepState(session, 'route', 'done', channelReason(channel))
      return { channel: channel.kind, skill: channel.kind === 'skill' ? channel.skill : undefined, reason: channel.reason }
    },
  }))

  ctx.tools?.register?.(defineTool({
    name: 'autoflow_report_step',
    description: '开发自动流：上报流水线某一步的真实进展（尤其 execute 执行验证：开工前报 active，交付后报 done/fail）。只上报你实际做过的事，不要预设完成。',
    parameters: {
      key: { type: 'string', description: '步骤 key：spec / check / route / execute / case。' },
      status: { type: 'string', description: '状态：active（进行中）/ done（完成）/ fail（失败）/ skipped（本次跳过）。' },
      note: { type: 'string', description: '一句话进展说明，如"已生成 3 个文件并跑通本地预览"。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          key: { type: 'string', required: true },
          status: { type: 'string', required: true },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value: { ok: boolean; key: string; status: string; message?: string }) => [
        { type: 'text', text: value.ok ? `已记录：${value.key} → ${value.status}` : `上报失败：${value.message ?? '未知错误'}` },
      ],
    },
    execute: async (args: { key?: string; status?: string; note?: string }, exec: { agent?: { id?: unknown } }) => {
      const session = sessionOf(exec)
      const key = typeof args?.key === 'string' ? args.key : ''
      const status = typeof args?.status === 'string' ? args.status : ''
      const allowedKeys = PIPELINE_STEPS.map((step) => step.key as string)
      const allowedStatus: StepStatus[] = ['active', 'done', 'fail', 'skipped']
      if (!allowedKeys.includes(key)) {
        return { ok: false, key, status, message: `key 必须是 ${allowedKeys.join(' / ')}` }
      }
      if (!allowedStatus.includes(status as StepStatus)) {
        return { ok: false, key, status, message: `status 必须是 ${allowedStatus.join(' / ')}` }
      }
      ensureRun(session)
      setStepState(session, key, status as StepStatus, typeof args?.note === 'string' ? args.note.slice(0, 200) : '')
      return { ok: true, key, status }
    },
  }))

  ctx.tools?.register?.(defineTool({
    name: 'autoflow_append_case',
    description: '开发自动流：任务完成后把经验沉淀进案例库（摘要/执行通道/交付形态/结果/教训），供后续任务复用。每完成一个开发任务调用一次。',
    parameters: {
      summary: { type: 'string', description: '任务摘要，一句话。' },
      channel: { type: 'string', description: '执行通道：direct / skill:<名称> / organize。' },
      deliverable: { type: 'string', description: '交付形态。' },
      result: { type: 'string', description: '结果：成功 / 部分成功 / 失败 + 一句话说明。' },
      lesson: { type: 'string', description: '教训/经验，一句话。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          created: {
            type: 'object',
            properties: {
              id: { type: 'number', required: true },
              summary: { type: 'string', required: true },
            },
            additionalProperties: false,
          },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value: { ok: boolean; created?: { id: number; summary: string }; message?: string }) => [
        {
          type: 'text',
          text: value.ok && value.created
            ? `案例 #${value.created.id} 已沉淀：${value.created.summary}`
            : `案例沉淀失败：${value.message ?? '未知错误'}`,
        },
      ],
    },
    execute: async (args: {
      summary?: string
      channel?: string
      deliverable?: string
      result?: string
      lesson?: string
    }, exec: { agent?: { id?: unknown } }) => {
      const session = sessionOf(exec)
      if (typeof args?.summary !== 'string' || args.summary.trim() === '') {
        return { ok: false, message: 'summary 必填' }
      }
      const created = await appendCase(caseFile, {
        date: new Date().toISOString().slice(0, 10),
        summary: args.summary.trim(),
        channel: typeof args.channel === 'string' ? args.channel : '',
        deliverable: typeof args.deliverable === 'string' ? args.deliverable : '',
        result: typeof args.result === 'string' ? args.result : '成功',
        lesson: typeof args.lesson === 'string' ? args.lesson : '无',
      })
      ensureRun(session)
      setStepState(session, 'case', 'done', `案例 #${created.id} 已沉淀`)
      finishProgress(session)
      return { ok: true, created: { id: created.id, summary: created.summary } }
    },
  }))

  // HTTP API — visual window polls /state.
  const webServer = ctx.webServer
  if (webServer === undefined) return
  const handler = (req: IncomingMessage, res: ServerResponse): void | Promise<void> => {
    return (async () => {
      await handleApi(req, res, { specScript, caseFile })
    })()
  }
  ctx.effect?.(
    () => webServer.register({ kind: 'prefix', path: '/api/autoflow', handler }),
    'dsh-dev-autoflow: api routes',
  )
  ctx.logger?.info?.(`dsh-dev-autoflow: API ready at /api/autoflow/*; tools registered; cases → ${caseFile}`)
}

/* ---------------- request handling ---------------- */

let pipelineRunning = false

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { specScript: string; caseFile: string },
): Promise<void> {
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    return sendJson(res, 400, { ok: false, message: 'invalid url' })
  }
  const { pathname } = url
  const session = url.searchParams.get('session') ?? lastSessionKey

  try {
    if (req.method === 'GET' && (pathname === '/api/autoflow/state' || pathname === '/api/autoflow/status')) {
      const cases = await loadCases(opts.caseFile)
      return sendJson(res, 200, {
        ok: true,
        session,
        pipeline: PIPELINE_STEPS.map((step) => step.label),
        caseCount: cases.length,
        cases,
        progress: currentProgress(session),
      })
    }
    if (req.method === 'GET' && pathname === '/api/autoflow/progress') {
      return sendJson(res, 200, { ok: true, session, progress: currentProgress(session) })
    }
    if (req.method === 'GET' && pathname === '/api/autoflow/cases') {
      const cases = await loadCases(opts.caseFile)
      return sendJson(res, 200, { ok: true, cases })
    }
    if (req.method === 'POST' && pathname === '/api/autoflow/run') {
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'untrusted origin' })
      if (!isJsonRequest(req)) return sendJson(res, 415, { ok: false, message: 'content-type must be application/json' })
      if (pipelineRunning) return sendJson(res, 409, { ok: false, message: 'a pipeline run is already in progress' })
      const body = await readJsonBody(req)
      const raw = typeof body?.raw === 'string' ? body.raw.trim() : ''
      if (raw === '') return sendJson(res, 400, { ok: false, message: 'raw requirement is required' })
      if (raw.length > 20000) return sendJson(res, 413, { ok: false, message: 'raw requirement is too long (max 20000 chars)' })

      pipelineRunning = true
      resetProgress(session)
      setStepState(session, 'spec', 'active', '正在重构需求规格…')
      try {
        const result: PipelineResult = await runPipeline(raw, opts)
        const assumptionNote = result.inferred.length > 0 ? `（${result.inferred.length} 项假设）` : ''
        setStepState(session, 'spec', 'done', `需求重构完成${assumptionNote}`)
        setStepState(
          session,
          'check',
          result.check.ok ? 'done' : 'fail',
          result.check.ok
            ? (result.check.degraded === true ? '结构检查通过（校验器不可用）' : '规格硬校验通过')
            : (result.check.problems[0] ?? '规格校验失败'),
        )
        setStepState(session, 'route', 'done', channelReason(result.channel))
        // This entry point does not execute the deliverable — say so instead of faking success.
        setStepState(session, 'execute', 'skipped', '该入口只产出规格/校验/路由，不执行交付')
        finishProgress(session, !result.check.ok)
        return sendJson(res, 200, {
          ok: true,
          session,
          specOk: result.check.ok,
          inferred: result.inferred,
          questions: result.questions,
          result,
        })
      } catch (error) {
        finishProgress(session, true)
        return sendJson(res, 500, { ok: false, message: errorMessage(error) })
      } finally {
        pipelineRunning = false
      }
    }
    if (req.method === 'POST' && pathname === '/api/autoflow/cases') {
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'untrusted origin' })
      if (!isJsonRequest(req)) return sendJson(res, 415, { ok: false, message: 'content-type must be application/json' })
      const body = await readJsonBody(req)
      const record = body?.record as Partial<CaseRecord> | undefined
      if (!record || typeof record.summary !== 'string') {
        return sendJson(res, 400, { ok: false, message: 'record.summary is required' })
      }
      const created = await appendCase(opts.caseFile, {
        date: record.date ?? new Date().toISOString().slice(0, 10),
        summary: record.summary,
        channel: record.channel ?? '',
        deliverable: record.deliverable ?? '',
        result: record.result ?? '成功',
        lesson: record.lesson ?? '无',
      })
      return sendJson(res, 200, { ok: true, created })
    }
    sendJson(res, 404, { ok: false, message: 'not found' })
  } catch (error) {
    sendJson(res, 500, { ok: false, message: errorMessage(error) })
  }
}

/* ---------------- helpers ---------------- */

/** Same-origin guard for mutating endpoints (blocks browser CSRF). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Require a JSON content type on mutations. Simple cross-origin form posts
 * cannot set this header, so it closes the gap left by Origin checks alone.
 */
function isJsonRequest(req: IncomingMessage): boolean {
  const contentType = String(req.headers['content-type'] ?? '')
  return contentType.toLowerCase().includes('application/json')
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolvePromise(text === '' ? {} : (JSON.parse(text) as Record<string, unknown>))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': data.length,
  })
  res.end(data)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function channelReason(channel: Channel): string {
  switch (channel.kind) {
    case 'direct':
      return channel.reason
    case 'skill':
      return `${channel.skill}：${channel.reason}`
    case 'organize':
      return channel.reason
    case 'explore':
      return channel.reason
  }
}
