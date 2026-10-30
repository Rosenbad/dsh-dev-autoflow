# dsh-dev-autoflow 全链路诊断与演化步骤

> 诊断日期：2026-10-31（真实运行验证：`npm run diagnose` 全流程通过）
> 结论：插件从「模式入口 → 聊天对话 → 工具调用 → 进度上报 → 窗口可视化 → 案例沉淀」闭环完整、可运行、可观测。
>
> **本文档描述的是当前代码的实际行为**，不是设计意图。上一版文档与代码有出入（check 步不会先 active、execute 由 finishProgress 收尾、案例数影响路由），已在 2026-10-31 的修复中纠正，详见 `CODE_REVIEW.md`。

---

## 一、插件正常运行：完整事件流

插件在 DSH 桌面版（Electron）里分 **host 端**（Node 主进程逻辑）和 **client 端**（浏览器渲染进程 UI）两半，由同一个 bundle patch 装配：

```
重启 DSH
  └─ cordis.patch.yml 被组合层解析
       ├─ 插件行 dsh-dev-autoflow 被加载
       └─ agent-preset「自动流」(order 25) 注册进模式下拉菜单
            └─ 工具面装配：bash/pwsh + fs + todo + web + skill + subagent 委派组 + compaction 组
                └─ host 端 apply(ctx) 执行
                     ├─ ctx.tools.register × 4（spec_check / route / report_step / append_case）
                     ├─ webServer.register /api/autoflow/*（prefix 路由）
                     └─ logger.info「API ready …; cases → <数据目录>」
                └─ client 端 apply(ctx) 执行
                     ├─ conversation.input.right ← 「自动流」开关按钮
                     └─ shell.overlay ← DevAutoflowDock（浮动窗口，CSS 注入 <style> 到 head）
```

### 正常运行的可观测证据（重启后应立即出现）

| 位置 | 应该看到 | 判断依据 |
|---|---|---|
| 模式下拉菜单 | 「自动流」（order 25） | cordis.patch.yml 的 agent-preset 行 |
| 聊天框输入区 | 输入框右侧出现「自动流」按钮 | client conversation.input.right 注入 |
| 点击按钮 | 浮出窗口：标题「自动流」+「执行步骤/案例库」页签 +「收起」按钮 | client shell.overlay 注入 + portal 到 body |
| 窗口可操作 | 标题栏拖动、边角缩放、位置记忆、Esc 或「收起」关闭 | localStorage 几何 + pointer 事件 |
| 案例库 | `~/.dsh/autoflow/cases.md` 自动创建（旧库会迁移） | 默认数据目录 |

> ⚠️ 若重启后模式菜单没有「自动流」：崩溃日志在 `C:\Users\32407\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\` 按时间戳找最新文件；profile 通过 Junction 实时同步工程目录，改完 build 即生效、无需重新 install。

---

## 二、窗口流程显示：五步状态的真实语义

窗口只轮询 `GET /api/autoflow/state`（2s 一次，全局共享一个定时器，窗口关闭即停），把 host 端**按会话隔离**的进度状态渲染成五个状态胶囊。

### 状态机定义（index.ts）

```
每个步骤 key：spec / check / route / execute / case
status 五态：pending（灰）→ active（高亮执行中）→ done（完成）| fail（失败红）| skipped（虚线灰，明确跳过）
```

进度以会话为键（`exec.agent.id`），两个对话互不覆盖。

### 完整演化时序（一次典型对话任务）

```
你在聊天框说：帮我做个员工考勤看板，要能看到迟到早退
  │
  ▼
① agent 重构规格（思考）
  │  首次调用任一工具时 ensureRun() 开一轮 → 窗口副标题出现「正在执行…」
  ▼
② agent 调用 autoflow_spec_check({ spec })
  │  host：check → active（窗口：规格硬校验 高亮）
  │        结构检查 + python 校验器
  │        通过 → check done + spec done（两格变绿）
  │        失败 → check fail + note 显示首条问题（agent 补齐后重试，不会重置已完成的步）
  │        校验器不可用 → check done，note 写「结构检查通过（校验器不可用）」
  ▼
③ agent 调用 autoflow_route({ deliverable, goal, featureCount })
  │  host：routeChannel() 按交付形态×规模判通道 → route done，note 显示通道名
  ▼
④ agent 执行交付，并用 autoflow_report_step 上报
  │  开工：{ key:'execute', status:'active', note:'正在生成页面' }  ← 窗口：执行验证 高亮
  │  交付：{ key:'execute', status:'done',   note:'3 个文件，本地预览通过' } ← 变绿
  │  host 不预设任何完成状态：没上报就一直是 pending
  ▼
⑤ agent 调用 autoflow_append_case(...)
  │  host：appendCase() 写库 → case done → finishProgress() 收尾（active=false）
  │        finishProgress 只把「正在执行」的步收成 done/fail，pending 保持 pending
  ▼
⑥ 窗口：五步按实际发生情况着色，「正在执行…」消失
```

### 窗口在四种情况下的显示

| 场景 | 窗口显示 |
|---|---|
| 未开始任务 | 五步全灰；副标题「已沉淀案例 N 条」；案例库页签「暂无案例」 |
| 任务进行中 | 当前步高亮 + 前序变绿；副标题「… · 正在执行…」；每步 note 分行展示 |
| 校验失败 | 规格硬校验 红 + note 首条问题；agent 补齐重校验后自动转绿 |
| 只走了部分流程 | 没上报的步保持灰（例如只做了规格就沉淀案例，execute 仍是 pending） |

> `POST /api/autoflow/run` 是程序化入口：规则解析需求 → 硬校验 → 路由，**不执行交付**，所以 execute 步显式标 `skipped`、case 步保持 pending，绝不伪装完成。返回体带 `specOk` / `inferred`（被填的假设字段）/ `questions`（需要用户确认的问题）。

### 需求重构的真实行为

`refineRequirement` 是规则解析（不是 LLM）：

| 字段 | 来源 | 读不到时 |
|---|---|---|
| 目标 | 首个子句（去掉"帮我/请/麻烦"） | 原文前 120 字 |
| 受众 | `受众是X`、`给X用/看` | 按交付形态给默认值 + 记 `inferred` |
| 交付形态 | 看板/网页/小程序/应用/脚本/表格/PPT/文档/图片/视频 | 按动词推断，仍无则 `未指定（按路由判定）` + 记 `inferred` |
| 核心功能 | 含"能/要/支持/导出/统计/筛选…"的子句 | 留空 → **校验失败**（这是唯一不能瞎猜的字段） |
| 范围边界 | `不做X`、`不包含X`、`排除X` | 默认最小实现 + 记 `inferred` |
| 技术约束 | `技术栈：X`、`用X实现`、`数据来自X`、`纯前端` | 按交付形态给默认值 + 记 `inferred` |
| 验收标准 | 由每条核心功能推导（可测动词） | 无核心功能则留空 |

因此「做个东西」会 FAIL 并追问核心功能，而「做个员工考勤看板，要能看到迟到早退」会 PASS 并列出 3~4 条假设。

---

## 三、案例库：位置、格式与更新

案例库是**唯一持久化文件**，默认 `~/.dsh/autoflow/cases.md`（`DSH_AUTOFLOW_HOME` 可覆盖目录），agent 与窗口共用，越用越准。

### 为什么不在包目录

旧版写在 `references/case-library.md`（插件包内），升级/重装即丢。现在落在用户数据目录，并在**首次启动且使用默认路径时**把旧库迁移过来（配置了自定义 `caseFile` 则不迁移，避免污染用户自己的文件）。

### 文件格式（appendCase 写入 / loadCases 解析）

```markdown
# 任务经验沉淀库

### 案例 1：员工考勤看板：迟到早退统计（静态网页）
- 日期：2026-10-31
- 需求要点：员工考勤看板：迟到早退统计（静态网页）
- 执行通道：skill:html
- 交付形态：网页
- 结果：成功
- 教训：数据量超10万行需提示分阶段
```

### 写入路径（谁在更新）

```
【自动写入】agent 工具 autoflow_append_case
  任务完成 → agent 调用 → appendCase()：
    ① loadCases() 读现有记录，取 max(id)+1（不按数组长度，手工删改后不会重号）
    ② 每个字段 sanitizeField()：折叠换行、去掉 # ` * > —— 一条带换行的摘要无法伪造出新的案例块
    ③ 文件不存在/为空 → 先写头「# 任务经验沉淀库」
    ④ appendFile 追加（不是读-改-写，降低并发丢写）
    ⑤ host 同步 case done → finishProgress() → 窗口案例数刷新

【API 写入】POST /api/autoflow/cases（同源 + JSON content-type 校验）
   body: { record: { summary, channel, deliverable, result, lesson } }
   同样走 appendCase()，返回 { ok, created }

【人工维护】直接编辑 cases.md（纯文本，格式对齐即可；id 从标题里的编号读取）
```

### 读取路径（谁在使用）

| 消费方 | 时机 | 内容 |
|---|---|---|
| 窗口·执行步骤 | 2s 轮询 `/api/autoflow/state` | caseCount + 最近 3 条案例卡片 |
| 窗口·案例库页签 | 同一份快照 | 全部案例（倒序展示） |
| agent 路由决策 | 每次 autoflow_route | 只依赖规格（交付形态/目标/功能数），**与案例条数无关** |

### 幂等与容错

- 重复调用 appendCase 永远追加新 id，不覆盖
- 文件损坏/不存在 → loadCases 返回 `[]`（窗口显示 0 条，不崩溃）
- 写文件失败（权限）→ appendCase 抛错 → host 500 → agent 可见错误信息
- 摘要为空 → 直接拒绝（不写半条脏记录）

---

## 四、API 契约

| 方法 | 路径 | 说明 | 失败码 |
|---|---|---|---|
| GET | `/api/autoflow/state?session=` | 聚合：progress + cases + caseCount | — |
| GET | `/api/autoflow/progress` | 仅进度 | — |
| GET | `/api/autoflow/cases` | 案例列表 | — |
| POST | `/api/autoflow/run` | `{ raw }` 规格草稿+校验+路由 | 403 非同类源 / 415 非 JSON / 409 已有运行 / 400 空 / 413 过长 |
| POST | `/api/autoflow/cases` | `{ record }` 追加案例 | 403 / 415 / 400 |

所有响应带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。

---

## 五、诊断结论

| 维度 | 结论 |
|---|---|
| 入口 | ✅ 模式菜单「自动流」+ 聊天框按钮 + 浮动窗口 |
| 工具链路 | ✅ 4 工具注册（真实 dsh-tools defineTool），typecheck/build/verify 全过 |
| 进度可视化 | ✅ 会话级状态机 → /state → 窗口单定时器轮询；未上报的步不会显示完成 |
| 案例库 | ✅ 用户目录、注入防护、id 单调、旧库迁移 |
| 已知缺口 | ① 需求重构是规则式，不做语义推理（口语化/隐含需求识别不了，交给 agent 补）；② 轮询 2s，可用 SSE 提升；③ 多会话同时沉淀无文件锁 |

## 六、复现诊断

```bash
npm run build                       # 重建（改 client.tsx/index.ts 后必跑）
npm run verify                      # 静态门控
npm run diagnose                    # 端到端：校验（好/坏规格）→ 路由 → 案例库往返 → 数据位置
npm test                            # 43 例：工作流单测 + host 集成测试
```
