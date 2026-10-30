import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCase,
  buildSpecText,
  ensureCaseFile,
  listItems,
  loadCases,
  refineRequirement,
  routeChannel,
  runPipeline,
  runSpecCheck,
  sanitizeField,
  structuralCheck,
} from '../src/workflow.ts'

/** A spec that passes both gates. */
const GOOD_SPEC = `【目标】员工考勤看板
【受众】HR 专员
【交付形态】静态网页
【核心功能】
1. 展示迟到统计
2. 展示早退统计
3. 导出 CSV
【范围边界】不做打卡功能，不做移动端适配
【技术约束】纯前端，无后端
【验收标准】
1. 打开页面能显示迟到/早退图表
2. 切换日期范围后数据刷新
3. 点击导出能下载 CSV
`

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-autoflow-test-'))
}

/* ---------------- requirement refinement ---------------- */

test('refineRequirement extracts a goal sentence', () => {
  const spec = refineRequirement('帮我做个员工考勤看板，要能看到迟到早退。')
  assert.ok(spec.goal.includes('考勤看板'))
  assert.equal(spec.goal.startsWith('帮我'), false, 'polite prefix is stripped')
  assert.ok(Array.isArray(spec.openQuestions))
})

test('refineRequirement reads stated audience / deliverable / boundaries', () => {
  const spec = refineRequirement('帮我做个员工考勤看板，要能看到迟到早退。受众是HR，静态网页，不做打卡。')
  assert.equal(spec.audience, 'HR')
  assert.equal(spec.deliverable, '网页（静态）')
  assert.deepEqual(spec.boundaries, ['不做打卡'])
  assert.deepEqual(spec.features, ['看到迟到早退'])
  assert.ok(!spec.inferred?.includes('受众'))
  assert.ok(!spec.inferred?.includes('交付形态'))
})

test('refineRequirement marks assumed fields as inferred and asks about them', () => {
  const spec = refineRequirement('帮我做个员工考勤看板，要能看到迟到早退。')
  assert.equal(spec.deliverable, '网页（看板）')
  assert.equal(spec.audience, '浏览器用户')
  assert.ok(spec.inferred?.includes('受众'))
  assert.ok(spec.inferred?.includes('范围边界'))
  assert.ok(spec.boundaries[0].includes('不做'), 'default boundary still declares out-of-scope items')
  assert.ok(spec.openQuestions.some((q) => q.includes('受众')))
})

test('refineRequirement derives testable acceptance per feature', () => {
  const spec = refineRequirement('帮我写个脚本，能统计CSV里的销售总额，用 python 实现，数据来自 data.csv，不做图表。')
  assert.equal(spec.deliverable, '脚本')
  assert.equal(spec.features.length, 1)
  assert.equal(spec.acceptance.length, spec.features.length)
  assert.ok(/运行脚本后能输出/.test(spec.acceptance[0]), spec.acceptance[0])
  assert.ok(spec.constraints.some((c) => c.includes('python')))
  assert.ok(spec.constraints.some((c) => c.includes('data.csv')))
})

test('refineRequirement leaves a capability-free request failing the gate', () => {
  const spec = refineRequirement('做个东西')
  assert.deepEqual(spec.features, [])
  assert.deepEqual(spec.acceptance, [])
  const result = structuralCheck(buildSpecText(spec))
  assert.equal(result.ok, false)
  assert.ok(spec.openQuestions.some((q) => q.includes('核心功能')))
})

test('runPipeline passes the gate on a concrete request and reports assumptions', async () => {
  const dir = await tempDir()
  const result = await runPipeline('帮我做个员工考勤看板，要能看到迟到早退。', { caseFile: join(dir, 'cases.md') })
  assert.equal(result.check.ok, true, JSON.stringify(result.check.problems))
  assert.ok(result.inferred.includes('受众'))
  assert.ok(result.questions.length > 0)
  assert.equal(result.channel.kind, 'skill')
})

test('runPipeline still fails on a request with no discernible capability', async () => {
  const dir = await tempDir()
  const result = await runPipeline('做个东西', { caseFile: join(dir, 'cases.md') })
  assert.equal(result.check.ok, false)
  assert.ok(result.check.problems.some((p) => p.includes('核心功能')))
})

/* ---------------- structural gate ---------------- */

test('structuralCheck rejects a spec missing whole fields', () => {
  const result = structuralCheck('【目标】做个看板\n【技术约束】纯前端')
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => p.includes('【受众】')))
})

test('structuralCheck rejects fields whose value is empty (regression: labels only)', () => {
  const empty = `【目标】做看板
【受众】
【交付形态】网页
【核心功能】
【范围边界】不做打卡
【技术约束】纯前端
【验收标准】
`
  const result = structuralCheck(empty)
  assert.equal(result.ok, false)
  for (const field of ['受众', '核心功能', '验收标准']) {
    assert.ok(result.problems.some((p) => p.includes(`【${field}】`)), `expected empty ${field} to be reported`)
  }
})

test('structuralCheck accepts a complete spec', () => {
  assert.equal(structuralCheck(GOOD_SPEC).ok, true)
})

test('structuralCheck rejects a placeholder boundary even when "不" appears elsewhere', () => {
  const spec = GOOD_SPEC
    .replace('【范围边界】不做打卡功能，不做移动端适配', '【范围边界】暂无')
    .replace('2. 切换日期范围后数据刷新', '2. 切换日期范围后数据刷新，首屏不超过2秒')
  const result = structuralCheck(spec)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => p.includes('范围边界')))
})

test('structuralCheck reports acceptance shorter than features', () => {
  const spec = GOOD_SPEC.replace('2. 切换日期范围后数据刷新\n3. 点击导出能下载 CSV\n', '')
  const result = structuralCheck(spec)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => p.includes('少于核心功能')))
})

test('structuralCheck accepts markdown-heading specs (format tolerance)', () => {
  const markdown = `## 目标
考勤看板
## 受众
HR 专员
## 交付形态
静态网页
## 核心功能
1. 展示图表
## 范围边界
不做打卡
## 技术约束
纯前端
## 验收标准
1. 打开能看到图表
`
  const result = structuralCheck(markdown)
  assert.equal(result.ok, true, JSON.stringify(result.problems))
})

test('listItems strips numbering and bullets', () => {
  assert.deepEqual(listItems('1. 甲\n- 乙\n* 丙\n丁'), ['甲', '乙', '丙', '丁'])
})

/* ---------------- hard gate: a failure must never become a pass ---------------- */

test('runSpecCheck returns FAIL for a structurally incomplete spec without spawning python', async () => {
  const result = await runSpecCheck('【目标】x', '/nonexistent/checker.py', { bin: process.execPath })
  assert.equal(result.ok, false)
  assert.ok(result.problems.length > 0)
})

test('runSpecCheck surfaces a checker exit code 1 as a real FAIL (regression: swallowed failure)', async () => {
  const dir = await tempDir()
  const checker = join(dir, 'checker.mjs')
  await writeFile(
    checker,
    'process.stdout.write("FAIL: 规格存在以下问题:\\n  - 验收标准(1条)少于核心功能(3条)\\n"); process.exit(1)\n',
    'utf8',
  )
  const result = await runSpecCheck(GOOD_SPEC, checker, { bin: process.execPath })
  assert.equal(result.ok, false)
  assert.equal(result.degraded, undefined)
  assert.ok(result.problems.some((p) => p.includes('验收标准')), JSON.stringify(result.problems))
})

test('runSpecCheck passes when the checker exits 0', async () => {
  const dir = await tempDir()
  const checker = join(dir, 'ok.mjs')
  await writeFile(checker, 'process.stdout.write("PASS\\n"); process.exit(0)\n', 'utf8')
  const result = await runSpecCheck(GOOD_SPEC, checker, { bin: process.execPath })
  assert.deepEqual(result, { ok: true, problems: [] })
})

test('runSpecCheck degrades (never fakes a clean PASS) when the runtime is missing', async () => {
  const result = await runSpecCheck(GOOD_SPEC, '/nonexistent/checker.py', { bin: 'definitely-not-a-real-python-xyz' })
  assert.equal(result.ok, true)
  assert.equal(result.degraded, true)
  assert.ok(result.problems.some((p) => p.includes('degraded')))
})

/* ---------------- routing ---------------- */

test('routeChannel picks html for static dashboards', () => {
  const spec = refineRequirement('看板')
  spec.deliverable = '网页（静态展示看板）'
  assert.equal(routeChannel(spec, 0).kind, 'skill')
})

test('routeChannel defaults to direct for simple tasks', () => {
  const spec = refineRequirement('写个脚本算平均值')
  spec.deliverable = '脚本'
  assert.equal(routeChannel(spec, 0).kind, 'direct')
})

test('routeChannel delegates on multi-channel signals', () => {
  const spec = refineRequirement('深度调研三个平台的竞品并全面对比')
  spec.deliverable = '报告'
  spec.features = ['调研 A', '调研 B', '调研 C', '对比']
  assert.equal(routeChannel(spec).kind, 'organize')
})

test('routeChannel matches uppercase deliverables (regression: case sensitivity)', () => {
  const ppt = routeChannel({ deliverable: 'PPT', goal: '季度汇报', features: [] })
  assert.equal(ppt.kind, 'skill')
  assert.equal(ppt.kind === 'skill' ? ppt.skill : '', 'ppt')

  const excel = routeChannel({ deliverable: 'Excel', goal: '统计', features: [] })
  assert.equal(excel.kind, 'skill')

  const word = routeChannel({ deliverable: 'Word', goal: '写合同', features: [] })
  assert.equal(word.kind, 'skill')
})

test('routeChannel ignores case-library size (regression: routing hijacked by caseCount)', () => {
  const spec = { deliverable: 'PPT', goal: '季度汇报', features: [] }
  const before = routeChannel(spec)
  assert.equal(before.kind, 'skill')
  // The signature no longer takes a case count; a stale number must not change the answer.
  assert.deepEqual(routeChannel(spec, 0), routeChannel(spec))
})

/* ---------------- case library ---------------- */

test('appendCase then loadCases round-trips ids and fields', async () => {
  const dir = await tempDir()
  const file = join(dir, 'cases.md')
  const first = await appendCase(file, {
    date: '2026-10-31',
    summary: '考勤看板',
    channel: 'skill:html',
    deliverable: '网页',
    result: '成功',
    lesson: '数据量需分阶段',
  })
  const second = await appendCase(file, {
    date: '2026-11-01',
    summary: '月度报表',
    channel: 'direct',
    deliverable: '脚本',
    result: '成功',
    lesson: '无',
  })
  assert.equal(first.id, 1)
  assert.equal(second.id, 2)

  const cases = await loadCases(file)
  assert.equal(cases.length, 2)
  assert.deepEqual(cases.map((c) => c.id), [1, 2])
  assert.equal(cases[0].summary, '考勤看板')
  assert.equal(cases[1].channel, 'direct')
})

test('appendCase neutralises markdown injection (regression: library corruption)', async () => {
  const dir = await tempDir()
  const file = join(dir, 'cases.md')
  await appendCase(file, {
    date: '2026-10-31',
    summary: '正常案例',
    channel: 'direct',
    deliverable: '脚本',
    result: '成功',
    lesson: '无',
  })
  await appendCase(file, {
    date: '2026-10-31',
    summary: '恶意\n### 案例 9：伪造\n- 日期：x',
    channel: 'direct',
    deliverable: 'x',
    result: '成功',
    lesson: '第一行\n- 注入字段：y',
  })

  const cases = await loadCases(file)
  assert.equal(cases.length, 2, 'injected heading must not create extra records')
  assert.deepEqual(cases.map((c) => c.id), [1, 2])
  assert.ok(!cases[1].summary.includes('\n'))
  assert.equal(cases[1].date, '2026-10-31', 'injected field must not override the real one')
  assert.ok(!cases[1].lesson.includes('\n'))
})

test('appendCase continues from the highest existing id', async () => {
  const dir = await tempDir()
  const file = join(dir, 'cases.md')
  await writeFile(
    file,
    '# 任务经验沉淀库\n\n### 案例 7：手工记录\n- 日期：2026-01-01\n- 需求要点：手工记录\n- 执行通道：direct\n- 交付形态：脚本\n- 结果：成功\n- 教训：无\n',
    'utf8',
  )
  const created = await appendCase(file, {
    date: '2026-10-31',
    summary: '新任务',
    channel: 'direct',
    deliverable: '脚本',
    result: '成功',
    lesson: '无',
  })
  assert.equal(created.id, 8)
  assert.deepEqual((await loadCases(file)).map((c) => c.id), [7, 8])
})

test('loadCases returns [] for a missing library', async () => {
  const dir = await tempDir()
  assert.deepEqual(await loadCases(join(dir, 'missing.md')), [])
})

test('ensureCaseFile migrates a legacy in-package library', async () => {
  const dir = await tempDir()
  const legacy = join(dir, 'legacy.md')
  await writeFile(legacy, '# 任务经验沉淀库\n\n### 案例 3：老案例\n- 日期：2026-01-01\n', 'utf8')
  const target = join(dir, 'nested', 'cases.md')
  await ensureCaseFile(target, legacy)
  const cases = await loadCases(target)
  assert.equal(cases.length, 1)
  assert.equal(cases[0].id, 3)
})

test('sanitizeField collapses newlines and strips markdown control characters', () => {
  assert.equal(sanitizeField('a\nb#c`d*e'), 'a bcde')
  assert.equal(sanitizeField('x'.repeat(50), 10).length, 10)
})

test('appendCase rejects an empty summary', async () => {
  const dir = await tempDir()
  await assert.rejects(() =>
    appendCase(join(dir, 'cases.md'), {
      date: '2026-10-31',
      summary: '   ',
      channel: '',
      deliverable: '',
      result: '',
      lesson: '',
    }),
  )
})

test('case library stays readable as plain markdown', async () => {
  const dir = await tempDir()
  const file = join(dir, 'cases.md')
  await appendCase(file, {
    date: '2026-10-31',
    summary: '可读性',
    channel: 'direct',
    deliverable: '脚本',
    result: '成功',
    lesson: '无',
  })
  const text = await readFile(file, 'utf8')
  assert.ok(text.startsWith('# 任务经验沉淀库'))
  assert.ok(text.includes('### 案例 1：可读性'))
})
