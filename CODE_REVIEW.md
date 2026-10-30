# dsh-dev-autoflow 代码审查与改进建议

> 审查日期：2026-10-31
> 审查方式：全量读码 + 运行校验链（typecheck / 单测 / 静态门控）+ 针对可疑逻辑写探针脚本实测
> 基线状态：`tsc --noEmit` 通过、6/6 单测通过、`verify-plugin.mjs` PASS —— **门控全绿，但核心语义有错**
>
> **修复状态（2026-10-31 当天完成，见 §6）**：P0 全部修复，P1 全部修复，P2 大部分修复；
> 回归测试 6 → 36 例，`npm run check` 与 `npm run diagnose` 全绿。

---

## 0. 总体评价

工程骨架是合格的：host/client 双半清晰、esbuild 打包契约（`__ModuleLoader__` 握手）正确、`defineTool` 用法规范、浮动窗口实现完整、文档详尽。

问题集中在**"宣称的能力"与"实际行为"不一致**：

| 宣称 | 实际 |
|---|---|
| 规格**硬**校验（PASS/FAIL 确定性门控） | python 判 FAIL 时被 catch 吞掉，返回 `ok: true` |
| 需求重构 → 结构化规格 | `refineRequirement` 只取第一行 + 3 条固定问题，其余字段恒为空 |
| 窗口实时反映五步状态 | 聊天路径下 `execute` 永远灰、`active` 永远 false |
| 案例库越用越准 | 一条带换行的 summary 就能把库写成 4 条伪造记录 |

换句话说：**"确定性"这层价值目前是空的**，真正干活的仍是聊天里的 agent。这不算致命——但代码里那套校验/路由/进度机在骗人，比没有更糟（会给出错误的绿灯）。

---

## 1. P0 — 正确性缺陷（会给出错误结论，建议优先修）

### 1.1 硬校验被静默降级：python FAIL 被当成环境缺失

`src/workflow.ts:110-131`

```ts
try {
  await execFileAsync('python', [resolve(scriptPath), tmp], { timeout: 15000 })
  return { ok: true, problems: [] }
} catch (error) {
  // python missing or script failed —— 但 exit code 1 也走这里
  return { ok: true, problems: [`python 校验未运行（…），已通过结构检查`] }
}
```

`execFile` 在**退出码非 0** 时也会 reject。`spec_check.py` 用 `exit 1` 表示"校验不通过"，于是真实的 FAIL 被当作"环境不可用"降级为 PASS。

实测（规格：7 字段齐全、范围边界写了"不做打卡"、核心功能 3 条、验收标准 1 条）：

```
python scripts/spec_check.py spec.txt
→ FAIL: 缺少必填字段【受众】…验收标准(1条)少于核心功能(3条)   exit=1

runSpecCheck(同一文本)
→ {"ok":true,"problems":["python 校验未运行（Command failed: …），已通过结构检查"]}
```

**影响**：`autoflow_spec_check` 是整条流水线的门闩（persona 里写"规格未通过禁止开工"），门闩恒开。

**修复**：区分"校验失败"与"环境不可用"。

```ts
try {
  const { stdout } = await execFileAsync(pythonBin, [script, tmp], { timeout: 15000 })
  return { ok: true, problems: [] }
} catch (error) {
  const e = error as { code?: number | string; stdout?: string }
  if (e.code === 1) {                       // 校验不通过 —— 这是结论，不是故障
    return { ok: false, problems: parseProblems(e.stdout ?? '') }
  }
  // ENOENT / 超时 → 降级，但必须显式标记 degraded，不能伪装成 PASS
  return { ok: structural.ok, degraded: true, problems: [`校验器不可用：${…}`] }
}
```

同时 `SpecCheckResult` 增加 `degraded?: boolean`，UI 与工具 render 区分「真通过」和「没跑成」。

### 1.2 结构检查只查标签存在，不查值非空

`src/workflow.ts:134-141` —— `text.includes('【目标】')` 就算过。

实测：

```
【目标】做看板
【受众】          ← 空
【交付形态】网页
【核心功能】      ← 空
【范围边界】不做打卡
【技术约束】纯前端
【验收标准】      ← 空
→ structuralCheck = {"ok":true,"problems":[]}
```

**影响**：`runPipeline` 产出的规格（`audience`/`features`/`acceptance` 恒为空）永远能过结构检查，`POST /api/autoflow/run` 因此返回 `check.ok: true` 并给窗口点绿灯。

**修复**：解析出字段值再判空。

```ts
const fields = parseFields(text)          // 复用 spec_check.py 的 extract_fields 逻辑
for (const f of REQUIRED) if (!fields[f]?.trim()) problems.push(`字段为空: 【${f}】`)
```

### 1.3 "范围边界必须声明不做"的检查是失效的

`src/workflow.ts:140-142`

```ts
if (!text.includes('不') && !text.includes('不做')) { … }
```

两个问题：
1. `includes('不做')` 是 `includes('不')` 的子集 → 第二个条件**永远为假**，死代码。
2. 扫的是**全文**，不是【范围边界】段。

实测：【范围边界】写"暂无"，但【验收标准】里有"打开页面不超过 2 秒" → 检查通过（因为全文含"不"）。

**修复**：

```ts
const boundary = fields['范围边界'] ?? ''
if (!/不做|不包含|不支持|排除/.test(boundary) || /^(暂无|无|待定)$/.test(boundary.trim())) {
  problems.push('【范围边界】未声明"不做"的内容（"暂无/无"不算声明）')
}
```

### 1.4 进度面板谎报：没做的事被标成 done

`index.ts:328`

```ts
setStepState('execute', 'done', '按验收标准交付，验证完成')   // /run 里没有任何执行发生
```

`index.ts:100-108` `finishProgress()` 把**所有 pending 步**改成 done；`index.ts:329` 的 case 步写"案例库现有 N 条"，但本次并没有沉淀任何案例。

**影响**：窗口是"可视化执行"，一旦开始撒谎，整个面板的观测价值归零。

**修复**（二选一）：
- 加 `autoflow_report_step({ key, status, note })` 工具，让 agent 自己上报 execute 的真实进展；host 只接受上报，不臆测。
- 或直接删掉 `execute` 步骤——五步里唯一没人真正驱动的一步，删掉比假绿好。

`finishProgress` 建议改为：只把 `active` 步收尾为 done，`pending` 保持 pending（或标 `skipped`），并新增 `skipped` 状态。

### 1.5 聊天路径的进度机根本没闭环

`finishProgress()` / `resetProgress()` 只在 `POST /run` 里被调用（`index.ts:321,330,333`）。真实使用走的是工具路径，于是：

- `progressActive` 恒为 `false` → 窗口副标题**永远不显示"正在执行…"**；
- `execute` 步永远 `pending`（灰）→ 窗口永远停在"四绿一灰"；
- 上一轮的状态不会重置，新对话会看到旧步骤残留（模块级单例，`index.ts:64-71`）。

`DIAGNOSIS.md` 第二节声称"execute 由 finishProgress 收尾"，与代码不符。

**修复**：`autoflow_spec_check` 入口调 `resetProgress()`；`autoflow_append_case` 成功后调 `finishProgress()`；并按会话隔离（见 1.6）。

### 1.6 进度状态是模块级单例，多会话串台

`index.ts:64-71` 一个 `progressState` 数组被所有会话共享；`/run` 也没有互斥，两次并发会交错写同一条状态机。

**修复**：`Map<sessionKey, ProgressState>`，sessionKey 从工具上下文的 sessionId 取；`/run` 加 running 标志，运行中返回 409。

### 1.7 案例库可被注入，且 id 会漂

`src/workflow.ts:229-237` 直接把 `summary` / `lesson` 拼进 markdown；`loadCases`（204-223）用 `id: i + 1`（数组下标）而非标题里的编号。

实测两次 append（第二次 summary 带换行 + `### 案例 9：伪造`）：

```
### 案例 2：恶意
### 案例 9：伪造
- 日期：x
- 日期：2026-10-31
- 需求要点：恶意
### 案例 9：伪造
…
→ loadCases 解析出 4 条，ids 1,2,3,4，末条 summary="伪造"
```

**影响**：agent 生成的 summary 来自用户输入，一条换行就污染库；手工编辑后 id 与标题编号脱节；`nextId = records.length + 1` 在删过案例后会重号。且 `appendCase` 是 read-modify-write（`loadCases` 读一次 + `readFile` 再读一次 + `writeFile`），并发追加会丢写。

**修复**：

```ts
const clean = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').replace(/^#+\s*/, '').trim()
const nextId = records.reduce((m, r) => Math.max(m, r.id), 0) + 1   // 从真实 id 推
await appendFile(caseFile, entry, 'utf8')                           // 追加而非重写
```

并把 `loadCases` 的 id 改为从 `### 案例 (\d+)：` 捕获组读取。

### 1.8 路由被"案例数"劫持 + 大小写敏感

`src/workflow.ts:163-166`

```ts
if (caseCount > 0 && spec.features.length === 0) return { kind: 'direct', reason: '有历史案例可复用…' }
```

实测：

```
{deliverable:'PPT', goal:'做个季度汇报', features:[]}
caseCount=0 → direct（"单文件/单任务"）
caseCount=1 → direct（"有历史案例可复用"）   ← PPT 任务被判 direct
```

**只要案例库里有 1 条记录，任何未填 features 的规格都路由到 direct**。而 `autoflow_route` 的 `featureCount` 是可选参数（`index.ts:176`），agent 不传时 `features` 就是 `[]` → 路由能力在第一次任务后即退化。

同时 `src/workflow.ts:179-196` 的正则无 `i` 标志：

```
deliverable='Excel' → direct   （期望 skill: sheet）
deliverable='Word'  → direct   （期望 skill: word）
deliverable='PPT'   → direct   （期望 skill: ppt）
```

**修复**：删掉 caseCount 分支（它没有真正"复用"任何东西，只是返回一句提示）；`featureCount` 给默认值（从规格文本数条目）；正则统一 `i` + `deliverable.toLowerCase()`。

---

## 2. P1 — 可靠性 / 安全 / 可移植

### 2.1 所有路径以 `process.cwd()` 为基准（装进 profile 后全错位）

`index.ts:163,207,261,305,338,348`、`workflow.ts:112,260` 全部用 `resolve('./references/…')`。装进 DSH profile 后 cwd 是 DSH 的启动目录，**案例库会写到那个目录**，而不是插件目录；多个项目共用同一 cwd 时互相污染。

**修复**：模块根用 `fileURLToPath(new URL('.', import.meta.url))` 作基准；用户数据不要放在包目录（见 2.3）。

### 2.2 临时文件泄漏 + 并发竞态

`workflow.ts:122` 把规格写到 `process.cwd()/.autoflow-spec-tmp.txt`，**从不删除**（当前仓库根目录已残留一个 `.autoflow-spec-tmp.txt`），且两次并发校验会互相覆盖。脚本本身支持 `-` 从 stdin 读（`spec_check.py:main`），直接走 stdin 即可，零临时文件。

### 2.3 案例库放在包安装目录，升级即丢

`package.json` 的 `files` 不含 `references/`；默认路径又指向包内 `./references/case-library.md`。结果：发布的 tarball 没有该文件，首次写入发生在 `node_modules/…/references/` 下，插件升级（重装）后被清空。

**修复**：迁到用户数据目录（`os.homedir()/.dsh/autoflow/cases.md` 或 ctx 提供的 dataDir），首次启动做一次从旧路径的迁移。

### 2.4 API 无鉴权、`/run` 无限流

`/api/autoflow/*` 全部无 token；GET 端点任何本地进程可读案例库；POST 只靠 `sameOrigin`（`index.ts:367-376`）——非浏览器客户端可随意伪造 `Origin` 头。`/run` 会拉起 python 子进程，可被反复触发。

**修复**：若 DSH 提供会话令牌则复用；否则至少加 `X-Autoflow-Token`（启动时随机生成、随页面注入），并对 `/run` 做互斥 + 简单限流。

### 2.5 python 探测不健壮

只试 `python`（`workflow.ts:124`）：Windows 上可能命中应用商店桩程序（卡住 15s 直到超时），macOS 通常只有 `python3`。

**修复**：候选 `['python3','python']`，启动时探测一次并缓存结果，只对 `ENOENT` 降级。

---

## 3. P2 — 工程质量

| # | 问题 | 建议 |
|---|---|---|
| 3.1 | **不是 git 仓库**，无 `.gitignore`、无 `LICENSE`（package.json 写 MIT）、无 CI | `git init`；忽略 `node_modules`/`index.js`/`client.js`/`index.d.ts`（或 CI 里 build 后 `git diff --exit-code` 防漂移） |
| 3.2 | 测试只覆盖 6 个纯函数用例；`appendCase`/`loadCases` 往返、注入、id、API handler、`spec_check.py`、python 降级路径全无 | 上面 P0 每一条都能写成一条回归测试，补 10~15 条即可锁住 |
| 3.3 | 文档与代码不符：`DIAGNOSIS.md` 说"check 先 active""execute 由 finishProgress 收尾""案例 >0 时路由复用"，代码里都没有 | 修完代码后同步文档；或把 DIAGNOSIS 标注为"目标态" |
| 3.4 | 客户端三路轮询：2s `/progress` + 2s `/status` + 4s `/cases`，且 `/status` 每次都读盘解析整库 | 合并为单个 `/api/autoflow/state`（一次返回 progress+cases+count），加 `ETag`/`mtime` 或改 SSE（DIAGNOSIS 自己也提到了） |
| 3.5 | 拖拽/缩放监听未在组件卸载时清理；只支持 mouse，无 pointer/touch | 用 `pointerdown/move/up` + `useEffect` 清理；补 `setPointerCapture` |
| 3.6 | 状态只靠颜色区分（`pending/active/done/fail`），无 aria、无键盘（Esc 关闭） | 步骤胶囊加 `aria-label` + 文字状态；面板加 Esc 关闭 |
| 3.7 | `index.d.ts` 由 `build.mjs` 手写字符串生成（`apply(ctx: any)`），tsconfig 的 `declaration: true` 未用上 | 用 `tsc --emitDeclarationOnly` 产出，或至少 `apply(ctx: unknown)` 保持类型 |
| 3.8 | `PIPELINE_STEPS` 在 host 与 client 各写一份（`index.ts:55` / `client.tsx:212`） | client 直接用 `/progress` 返回的 `label`，删掉本地副本 |
| 3.9 | `structuralCheck` 只认全角 `【】`，agent 写 `## 目标` 或 `目标：` 全挂 | 做一层归一化（全角/半角括号、冒号、标题符号）再解析 |
| 3.10 | 失败只回 `{message}`，无 stack / 无耗时日志 | `logger.warn` 带上 error.stack 与阶段耗时；`/run` 返回 `stage` 字段便于定位 |
| 3.11 | `autoflow_route` 用 `Array.from({length: featureCount}, (_,i)=>'f'+(i+1))` 伪造 features 只为计数 | `routeChannel(spec, { featureCount })` 直接接数字，别造假数组 |

---

## 4. 建议的修复顺序

**第一批（半天，修"给错误结论"的问题）**
1.1 校验降级不再伪装 PASS → 1.2 空字段 → 1.3 边界检查 → 1.7 案例库注入/id → 1.8 路由劫持与大小写
每条配一个回归测试（现在 6 条 → 12 条左右）。

**第二批（1 天，修"闭环与信任"）**
1.4 进度不臆测 → 1.5 工具路径 reset/finish → 1.6 按会话隔离 → 2.1/2.2/2.3 路径与数据落地 → 2.5 python 探测

**第三批（工程化）**
3.1 git + CI + LICENSE → 3.2 补测试 → 3.4 合并轮询/SSE → 3.5/3.6 交互与可访问性 → 3.7/3.8 类型与去重

**可选的产品判断**：如果短期内不接 LLM 做真实的需求重构，建议把 `POST /api/autoflow/run` + `refineRequirement` + `runPipeline` 整条路径**下架**（它们产出的规格必然不合格），只保留三个 agent 工具 + 进度窗口 + 案例库。少一条假路径，比留一条会点绿灯的假路径更好。

---

## 5. 复现方式

```bash
npm run typecheck && npm test && npm run verify     # 全绿（但掩盖了上述语义问题）

# 1.1 校验被吞
python scripts/spec_check.py <(printf '【目标】x\n【受众】\n【交付形态】网页\n【核心功能】\n【范围边界】不做\n【技术约束】无\n【验收标准】\n')   # FAIL
node -e "import('./src/workflow.ts').then(m=>m.runSpecCheck('…同一文本…').then(console.log))"   # ok:true

# 1.8 路由
node -e "import('./src/workflow.ts').then(m=>console.log(m.routeChannel({deliverable:'PPT',goal:'汇报',features:[]},1)))"
```

---

## 6. 修复记录（2026-10-31）

### P0 — 已全部修复

| 编号 | 问题 | 修复方式 | 锁定的回归测试 |
|---|---|---|---|
| 1.1 | python exit 1 被吞成 PASS | `spawn` 区分退出码：1=真 FAIL，ENOENT/超时=`degraded: true`（不再伪装干净 PASS） | `runSpecCheck surfaces a checker exit code 1 as a real FAIL` / `degrades (never fakes a clean PASS)` |
| 1.2 | 空字段放行 | `parseFields` 解析出字段值后判空（`缺少或为空`） | `rejects fields whose value is empty` |
| 1.3 | 边界检查被全文"不"污染 | 只看【范围边界】段，要求含"不做/不包含/排除"，且排除"无/暂无/待定" | `rejects a placeholder boundary even when "不" appears elsewhere` |
| 1.4 | 进度谎报 | 新增 `skipped` 状态；`/run` 的 execute 标 `skipped`；`finishProgress` 只收尾 active 步，pending 保持 pending | `POST /run marks execute as skipped instead of faking completion` / `finishProgress never marks an unreported step as done` |
| 1.5 | 聊天路径进度不闭环 | 工具入口 `ensureRun()` 开轮，`append_case` 后 `finishProgress()` | `full chat pipeline drives every step and closes the run` |
| 1.6 | 单例串台 | 进度改为 `Map<sessionKey, ProgressState>`，sessionKey = `exec.agent.id` | `progress is isolated per session` |
| 1.7 | 案例库注入 / id 漂移 | `sanitizeField`（折叠换行、去 `# \` * >`）、id 取 `max(标题编号)+1`、`appendFile` 追加 | `neutralises markdown injection` / `continues from the highest existing id` |
| 1.8 | 路由被案例数劫持 + 大小写 | 删除 caseCount 分支（签名不再接收案例数），交付形态统一小写匹配 | `ignores case-library size` / `matches uppercase deliverables` |

### P1 — 已全部修复

- **2.1 路径基准**：`findPackageRoot()`（向上找 `package.json` + `cordis.patch.yml`）取代 `process.cwd()`；`resolveConfigPath()` 统一相对包根解析。
- **2.2 临时文件**：校验文本走 stdin（`spec_check.py -`），零临时文件；实测仓库根不再残留 `.autoflow-spec-tmp.txt`。
- **2.3 案例库落地**：默认 `~/.dsh/autoflow/cases.md`（`DSH_AUTOFLOW_HOME` 可覆盖）；仅当使用默认路径时迁移旧库，自定义 `caseFile` 不迁移。
- **2.4 API 加固**：POST 增加 `application/json` content-type 门禁（415）、`/run` 互斥（409）+ 长度上限（413）、响应加 `nosniff`。
- **2.5 python 探测**：`python`/`py`/`python3` 依次探测并缓存，`windowsHide`，超时兜底。

### P2 — 大部分修复

- 已 `git init`（首次提交 867de14）、补 `.gitignore`、`LICENSE`；产物（`index.js`/`client.js`/`index.d.ts`）不再入库，由 `prepack` 生成。
- 测试 6 → 36 例：新增 `test/host.test.mjs`（工具链 + API 集成，11 例）。
- 客户端：三路轮询合并为单 `/state` 端点 + 全局共享定时器（窗口关闭即停）；`pointerdown` 取代 mouse 事件并在卸载时清理；Esc 关闭；`aria-label`/`role`/`focus-visible`；`skipped` 样式。
- 文档：README 与 DIAGNOSIS 重写为"实际行为"，补充校验语义表与已知限制。
- 仍留待后续：`index.d.ts` 仍由 build 脚本生成（已补全导出）、SSE 推送、案例库文件锁、CI workflow。

---

## 7. 后续：接上真实需求重构（2026-10-31 第二迭代）

第 5 节留了一个产品判断：`refineRequirement` 是桩，`POST /run` 恒 FAIL，要么接上真实重构、要么下架。**选择接上**，实现为可测试的规则解析（不是 LLM）。

- **读取而非猜测**：目标、受众（`受众是X` / `给X用`）、交付形态（11 类关键词表）、核心功能（含能力动词的子句）、范围边界（`不做/不包含/排除`）、技术约束（`用X实现` / `数据来自X` / `纯前端` 等）。
- **默认值必须留痕**：受众、交付形态、范围边界、技术约束读不到时按交付形态给默认值，同时写入 `spec.inferred` 与 `spec.openQuestions`——假设永不静默。
- **验收标准逐条推导**：`打开后可看到X` / `点击导出能下载X` / `运行脚本后能输出X的结果` / `交付文档中包含X`，按交付形态选句式，保证含可测动词。
- **唯一不许猜的字段是核心功能**：读不到就留空 → 校验 FAIL + 追问。所以「做个东西」仍然诚实失败，「做个考勤看板要能看到迟到早退」可以 PASS 并列出 3~4 条假设。

接口变化：`PipelineResult` 增加 `inferred` / `questions`；`POST /run` 响应增加 `specOk` / `inferred` / `questions`；`/run` 的 spec 步 note 显示「（N 项假设）」。

未接 LLM 的原因：`ctx.llm.stream()` 需要显式 `provider` + `model`，DSH 侧没有默认模型选择器，自动挑选不可靠且无法在此环境验证。保留 `runPipeline(raw, opts)` 作为注入点，后续可加 `opts.refiner`。

测试：36 → 43 例（新增重构语义 5 例 + host `/run` 两条路径）。
