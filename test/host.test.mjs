/**
 * host.test.mjs — integration tests for the built host bundle (index.js).
 *
 * Runs against the shipped artifact (build runs in `pretest`), driving the real
 * tool definitions and the real HTTP handler with a fake webServer, so the
 * tool → progress-state → API → client contract is covered end to end.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, currentProgress } from '../index.js'

const GOOD_SPEC = `【目标】员工考勤看板
【受众】HR 专员
【交付形态】静态网页
【核心功能】
1. 展示迟到统计
2. 展示早退统计
【范围边界】不做打卡功能
【技术约束】纯前端
【验收标准】
1. 打开页面能显示图表
2. 点击导出能下载 CSV
`

const BAD_SPEC = `【目标】做看板
【受众】
【交付形态】网页
【核心功能】
【范围边界】暂无
【技术约束】纯前端
【验收标准】
`

async function boot() {
  const tools = []
  const routes = []
  const ctx = {
    tools: { register: (tool) => { tools.push(tool); return tool } },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-autoflow-host-'))
  const caseFile = join(dir, 'cases.md')
  apply(ctx, { caseFile })
  const handler = routes[0]?.handler
  assert.equal(typeof handler, 'function', 'api route must be registered')
  const tool = (name) => {
    const found = tools.find((item) => item.name === name)
    assert.ok(found, `tool ${name} must be registered`)
    return found
  }
  return { tools, handler, caseFile, tool }
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

async function get(handler, url) {
  const res = mockResponse()
  await handler({ method: 'GET', url, headers: {} }, res)
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) }
}

async function post(handler, url, payload, headers = {}) {
  const res = mockResponse()
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  req.method = 'POST'
  req.url = url
  req.headers = { origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json', ...headers }
  await handler(req, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

const exec = (session) => ({ agent: { id: session } })

test('apply registers four tools and one API route', async () => {
  const { tools } = await boot()
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['autoflow_append_case', 'autoflow_report_step', 'autoflow_route', 'autoflow_spec_check'],
  )
})

test('spec_check reports FAIL and marks the step red', async () => {
  const { tool } = await boot()
  const result = await tool('autoflow_spec_check').execute({ spec: BAD_SPEC }, exec('s-fail'))
  assert.equal(result.ok, false)
  const progress = currentProgress('s-fail')
  const check = progress.steps.find((step) => step.key === 'check')
  assert.equal(check.status, 'fail')
  assert.equal(progress.active, true, 'a run must be considered in flight after the first tool call')
})

test('full chat pipeline drives every step and closes the run', async () => {
  const { tool, caseFile } = await boot()
  const session = 's-ok'

  const check = await tool('autoflow_spec_check').execute({ spec: GOOD_SPEC }, exec(session))
  assert.equal(check.ok, true, JSON.stringify(check.problems))

  const route = await tool('autoflow_route').execute({ deliverable: '静态网页看板', goal: '展示考勤', featureCount: 2 }, exec(session))
  assert.equal(route.channel, 'skill')

  const reported = await tool('autoflow_report_step').execute({ key: 'execute', status: 'active', note: '正在生成页面' }, exec(session))
  assert.equal(reported.ok, true)
  assert.equal(currentProgress(session).steps.find((s) => s.key === 'execute').status, 'active')

  const appended = await tool('autoflow_append_case').execute({
    summary: '考勤看板',
    channel: 'skill:html',
    deliverable: '网页',
    result: '成功',
    lesson: '无',
  }, exec(session))
  assert.equal(appended.ok, true)
  assert.equal(appended.created.id, 1)

  const progress = currentProgress(session)
  assert.equal(progress.active, false, 'append_case closes the run')
  const byKey = Object.fromEntries(progress.steps.map((step) => [step.key, step.status]))
  assert.equal(byKey.spec, 'done')
  assert.equal(byKey.check, 'done')
  assert.equal(byKey.route, 'done')
  assert.equal(byKey.execute, 'done', 'active → done on finish, only because the agent reported it')
  assert.equal(byKey.case, 'done')
  assert.ok(caseFile.length > 0)
})

test('finishProgress never marks an unreported step as done', async () => {
  const { tool } = await boot()
  const session = 's-partial'
  await tool('autoflow_spec_check').execute({ spec: GOOD_SPEC }, exec(session))
  await tool('autoflow_append_case').execute({ summary: '只做了规格' }, exec(session))
  const byKey = Object.fromEntries(currentProgress(session).steps.map((step) => [step.key, step.status]))
  assert.equal(byKey.execute, 'pending', 'execute was never reported, so it must stay pending')
})

test('progress is isolated per session', async () => {
  const { tool } = await boot()
  await tool('autoflow_spec_check').execute({ spec: GOOD_SPEC }, exec('session-a'))
  await tool('autoflow_spec_check').execute({ spec: BAD_SPEC }, exec('session-b'))

  assert.equal(currentProgress('session-a').steps.find((s) => s.key === 'check').status, 'done')
  assert.equal(currentProgress('session-b').steps.find((s) => s.key === 'check').status, 'fail')
})

test('report_step rejects unknown keys and statuses', async () => {
  const { tool } = await boot()
  const badKey = await tool('autoflow_report_step').execute({ key: 'nope', status: 'done' }, exec('s-bad'))
  assert.equal(badKey.ok, false)
  const badStatus = await tool('autoflow_report_step').execute({ key: 'execute', status: 'maybe' }, exec('s-bad'))
  assert.equal(badStatus.ok, false)
})

test('GET /api/autoflow/state aggregates progress and cases', async () => {
  const { tool, handler } = await boot()
  await tool('autoflow_spec_check').execute({ spec: GOOD_SPEC }, exec('s-state'))
  await tool('autoflow_append_case').execute({ summary: '状态查询' }, exec('s-state'))

  const { status, body, headers } = await get(handler, '/api/autoflow/state?session=s-state')
  assert.equal(status, 200)
  assert.equal(headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(body.caseCount, 1)
  assert.equal(body.cases[0].summary, '状态查询')
  assert.equal(body.progress.steps.find((s) => s.key === 'check').status, 'done')
})

test('GET /api/autoflow/status stays a compatible alias', async () => {
  const { handler } = await boot()
  const { status, body } = await get(handler, '/api/autoflow/status')
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.pipeline))
  assert.ok(body.progress)
})

test('POST /run rejects untrusted origins and non-JSON bodies', async () => {
  const { handler } = await boot()
  const badOrigin = await post(handler, '/api/autoflow/run', { raw: 'x' }, { origin: 'http://evil.example' })
  assert.equal(badOrigin.status, 403)

  const noJson = await post(handler, '/api/autoflow/run', { raw: 'x' }, { 'content-type': 'text/plain' })
  assert.equal(noJson.status, 415)

  const empty = await post(handler, '/api/autoflow/run', { raw: '   ' })
  assert.equal(empty.status, 400)
})

test('POST /run refines a concrete request and marks execute as skipped', async () => {
  const { handler } = await boot()
  const { status, body } = await post(handler, '/api/autoflow/run?session=s-run', {
    raw: '帮我做个员工考勤看板，要能看到迟到早退。',
  })
  assert.equal(status, 200)
  assert.equal(body.specOk, true, JSON.stringify(body.result.check.problems))
  assert.ok(body.inferred.includes('受众'), 'assumed fields must be reported')
  assert.ok(body.questions.length > 0)
  assert.equal(body.result.channel.kind, 'skill')

  const progress = currentProgress('s-run')
  const byKey = Object.fromEntries(progress.steps.map((step) => [step.key, step.status]))
  assert.equal(byKey.execute, 'skipped')
  assert.equal(byKey.case, 'pending', 'this entry point does not append cases')
  assert.equal(progress.active, false)
})

test('POST /run fails honestly when the request has no capability', async () => {
  const { handler } = await boot()
  const { status, body } = await post(handler, '/api/autoflow/run?session=s-vague', { raw: '做个东西' })
  assert.equal(status, 200)
  assert.equal(body.specOk, false)
  assert.ok(body.questions.some((q) => q.includes('核心功能')))
  assert.equal(currentProgress('s-vague').steps.find((step) => step.key === 'check').status, 'fail')
})

test('unknown API paths return 404 JSON', async () => {
  const { handler } = await boot()
  const { status, body } = await get(handler, '/api/autoflow/nope')
  assert.equal(status, 404)
  assert.equal(body.ok, false)
})
