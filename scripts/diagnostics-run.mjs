/**
 * diagnostics-run.mjs — end-to-end pipeline exercise.
 *
 * Runs the real gates (structural + bundled python validator) on a good and a
 * bad spec, exercises routing, and round-trips the case library in a temp dir
 * (never touching the user's real library). Exits non-zero if any expectation
 * fails, so it doubles as a smoke test.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCase,
  buildSpecText,
  defaultCaseFile,
  DEFAULT_SPEC_SCRIPT,
  loadCases,
  refineRequirement,
  routeChannel,
  runPipeline,
  runSpecCheck,
} from '../src/workflow.ts'

const failures = []
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

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

const BAD_SPEC = `【目标】做个看板
【受众】
【交付形态】网页
【核心功能】
【范围边界】暂无
【技术约束】纯前端
【验收标准】
`

const dir = await mkdtemp(join(tmpdir(), 'dsh-autoflow-diag-'))
const caseFile = join(dir, 'cases.md')

console.log('=== 1. 规格硬校验：好规格应 PASS ===')
console.log(`  validator: ${DEFAULT_SPEC_SCRIPT}`)
const good = await runSpecCheck(GOOD_SPEC)
console.log(`  result: ${JSON.stringify(good)}`)
expect('good spec passes', good.ok === true)
expect('good spec is not degraded', good.degraded !== true, 'python validator unavailable')

console.log('\n=== 2. 规格硬校验：空字段/占位边界应 FAIL（回归：不得伪装 PASS）===')
const bad = await runSpecCheck(BAD_SPEC)
console.log(`  result: ${JSON.stringify(bad)}`)
expect('bad spec fails', bad.ok === false)
expect('bad spec reports problems', bad.problems.length > 0)

console.log('\n=== 3. 需求重构 + 整条流水线 ===')
const raw = '帮我做个员工考勤看板，要能看到迟到早退。受众是HR，静态网页，不做打卡。'
const spec = refineRequirement(raw)
console.log(`  goal: ${spec.goal}`)
console.log(`  deliverable: ${spec.deliverable} | audience: ${spec.audience}`)
console.log(`  specText:\n${buildSpecText(spec).split('\n').map((l) => `    ${l}`).join('\n')}`)
const pipeline = await runPipeline(raw, { caseFile })
console.log(`  check: ${JSON.stringify(pipeline.check)}`)
console.log(`  channel: ${pipeline.channel.kind} — ${pipeline.channel.reason}`)
console.log(`  inferred: ${JSON.stringify(pipeline.inferred)}`)
console.log(`  questions: ${JSON.stringify(pipeline.questions)}`)
expect('concrete request passes the gate', pipeline.check.ok === true)
expect('assumptions are reported, not hidden', pipeline.inferred.length > 0)
expect('explicit fields are not marked inferred', !pipeline.inferred.includes('受众'))

const vague = await runPipeline('做个东西', { caseFile })
console.log(`  vague request → check: ${JSON.stringify(vague.check)}`)
expect('capability-free request fails honestly', vague.check.ok === false)
expect('failure comes with questions', vague.questions.some((q) => q.includes('核心功能')))

console.log('\n=== 4. 通道路由（大小写 / 案例数无关）===')
const routes = [
  { deliverable: 'PPT', goal: '季度汇报', features: [] },
  { deliverable: 'Excel', goal: '统计', features: [] },
  { deliverable: '静态网页看板', goal: '展示', features: [] },
  { deliverable: '脚本', goal: '算平均值', features: [] },
]
for (const item of routes) {
  const channel = routeChannel(item)
  console.log(`  ${item.deliverable} → ${channel.kind}${channel.skill ? ` (${channel.skill})` : ''}`)
  expect(`${item.deliverable} routes to a skill or direct`, channel.kind === 'skill' || channel.kind === 'direct')
}
expect('PPT routes to the ppt skill', routeChannel(routes[0]).kind === 'skill')

console.log('\n=== 5. 案例库：写入 / 回读 / 注入防护 ===')
const first = await appendCase(caseFile, {
  date: '2026-10-31',
  summary: '员工考勤看板：迟到早退统计（静态网页）',
  channel: 'skill:html',
  deliverable: '网页',
  result: '成功',
  lesson: '数据量超10万行需提示分阶段',
})
const second = await appendCase(caseFile, {
  date: '2026-10-31',
  summary: '恶意\n### 案例 9：伪造\n- 日期：x',
  channel: 'direct',
  deliverable: 'x',
  result: '成功',
  lesson: '第一行\n- 注入字段：y',
})
const cases = await loadCases(caseFile)
console.log(`  created: #${first.id} / #${second.id}`)
console.log(`  parsed: ${cases.length} 条 → ${cases.map((c) => `#${c.id}`).join(', ')}`)
expect('ids are monotonic', first.id === 1 && second.id === 2)
expect('injection does not create extra records', cases.length === 2)
expect('injected date does not override the real one', cases[1].date === '2026-10-31')

console.log('\n=== 6. 库文件可读性 ===')
const text = await readFile(caseFile, 'utf8')
console.log(text.split('\n').slice(0, 9).map((l) => `  ${l}`).join('\n'))
expect('library starts with the header', text.startsWith('# 任务经验沉淀库'))

console.log('\n=== 7. 数据位置 ===')
console.log(`  user case library: ${defaultCaseFile()}`)
expect('case library lives outside the package', !defaultCaseFile().includes('dsh-dev-autoflow'))

console.log(`\nDIAG ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`)
process.exit(failures.length === 0 ? 0 : 1)
