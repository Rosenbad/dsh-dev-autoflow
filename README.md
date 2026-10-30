# dsh-dev-autoflow

开发任务自动流编排插件：**需求重构 → 规格硬校验 → 通道路由 → 执行验证 → 案例沉淀**，附可视化执行窗口（浮动态，仿 dsh-purge 窗口模式）。

## 使用方式

1. 安装后重启 DSH，**模式选择下拉菜单**出现「自动流」（order 25）。
2. 选定「自动流」模式，直接在**聊天框**描述开发需求（如「帮我做个员工考勤看板，要能看到迟到早退」）。
3. 对话中的 agent 会按流水线处理：重构规格 → 调 `autoflow_spec_check` 硬校验 → 调 `autoflow_route` 推荐执行通道 → 执行并调 `autoflow_report_step` 上报进展 → 调 `autoflow_append_case` 沉淀案例。
4. 点聊天框旁的「自动流」按钮或标题栏收起/打开**浮动执行窗口**（可拖动、可缩放、位置记忆、Esc 关闭），实时看五步状态。

## 功能

- **模式入口**：`cordis.patch.yml` 声明式注册 `@deepseek-ai/dsh-agent-preset`（prefix 风格 persona + 完整开发工具面：bash/pwsh、fs、todo、web、skill、subagent 委派组、compaction 组）
- **Host 端**（`index.js`）：注册 4 个 agent 工具 + 同源 JSON API `/api/autoflow/*`
  - `autoflow_spec_check` — 规格硬校验（PASS/FAIL + 问题清单；校验器不可用时返回 `degraded`）
  - `autoflow_route` — 推荐执行通道（direct / skill / organize / explore）
  - `autoflow_report_step` — 上报某一步的真实进展（execute 步骤由 agent 主动上报，host 不臆测）
  - `autoflow_append_case` — 沉淀案例到经验库，并收尾本轮进度
  - `GET /api/autoflow/state` — 进度 + 案例的聚合端点（窗口只轮询这一个）
  - `GET /api/autoflow/progress` / `status` / `cases` — 兼容端点
  - `POST /api/autoflow/run` — `{ raw }` 需求重构（规则解析）→ 硬校验 → 路由建议；返回 `specOk` / `inferred` / `questions`（**不执行交付**，execute 步标记 `skipped`）
  - `POST /api/autoflow/cases` — 沉淀新案例
- **Client 端**（`client.js`）：浮动态执行窗口（仿 dsh-purge）——标题栏拖动、四向缩放、Esc 收起、标签页（执行步骤 / 案例库）、深色玻璃拟态、localStorage 几何记忆、单个共享轮询定时器（窗口关闭即停）
- **确定性硬校验**：结构检查（零依赖）→ 捆绑的 `scripts/spec_check.py`（stdin 传入，无临时文件）
- **案例库落用户目录**：`~/.dsh/autoflow/cases.md`（可用 `DSH_AUTOFLOW_HOME` 覆盖），升级插件不丢数据；首次启动会把旧的包内 `references/case-library.md` 迁移过来

## 安装

```
dsh plugin --profile web add .
```

安装后重启 `dsh web`，在对话界面打开 dev-autoflow 执行窗口即可。

## 开发与测试

```
npm install
npm run typecheck    # tsc --noEmit
npm test             # 构建 + node --test（工作流单测 + host 集成测试，43 例）
npm run diagnose     # 端到端诊断（真实跑校验/路由/案例库，失败即退出非 0）
npm run build        # esbuild → index.js / client.js / index.d.ts
npm run verify       # DSH Plugin Standard v2.0 静态门控
npm run check        # typecheck + test + verify
```

## 结构

```
dsh-dev-autoflow/
├── package.json          # dsh.bundle.patch + dsh.client 声明 + dsh-tools peer
├── cordis.patch.yml      # 模式化插件：insert 插件行 + agent-preset「自动流」
├── build.mjs             # esbuild 构建脚本（host ESM + client CJS/ModuleLoader）
├── index.ts              # Host 端：4 个 agent 工具 + /api/autoflow/* + 会话级进度状态机
├── client.tsx            # Client 端：浮动态执行窗口（仿 dsh-purge）
├── src/workflow.ts       # 核心：规格解析/硬校验/路由/案例库
├── scripts/
│   ├── spec_check.py     # 规格硬校验脚本（确定性门控）
│   ├── verify-plugin.mjs # DSH 标准静态门控（含 preset 结构检查）
│   └── diagnostics-run.mjs # 端到端诊断（校验/路由/案例库，失败即非 0）
└── test/                 # workflow.test.mjs（纯函数）+ host.test.mjs（工具与 API）
```

## 校验语义（重要）

| 返回 | 含义 | 调用方应如何处理 |
|---|---|---|
| `ok: true` | 结构检查 + python 校验器都通过 | 可以开工 |
| `ok: false` | 真的没通过（含校验器 exit 1） | 按 `problems` 补齐后重新校验，禁止开工 |
| `ok: true, degraded: true` | 校验器不可用（缺 python/超时），只过了结构检查 | 视为**软通过**，必须在交付说明里写明 |

## 需求重构：规则解析 + 显式假设

`refineRequirement` 不是 LLM 改写，而是一套可测试的规则解析：

- **从原文读取**：目标、受众（`受众是HR`）、交付形态（看板/网页/脚本/表格/PPT/文档…）、核心功能（含"能/要/支持/导出/统计…"的子句）、范围边界（`不做X`）、技术约束（`用 python 实现`、`数据来自 data.csv`、`纯前端`）。
- **不能读取就填默认值并标记**：受众、交付形态、范围边界、技术约束都有按交付形态定制的默认值，全部记入 `inferred`，同时生成 `openQuestions`。
- **验收标准按核心功能逐条推导**：`打开后可看到迟到早退`、`点击导出能下载…`、`运行脚本后能输出…`，保证可测。

所以：

| 输入 | 结果 |
|---|---|
| 「做个员工考勤看板，要能看到迟到早退。受众是HR，静态网页，不做打卡。」 | `specOk: true`，`inferred` 只剩技术约束/验收标准 |
| 「做个员工考勤看板，要能看到迟到早退。」 | `specOk: true`，`inferred` 含受众/范围边界/技术约束/验收标准，并给出对应问题 |
| 「做个东西」 | `specOk: false`，缺核心功能与验收标准，`questions` 要求补充 |

**假设从不静默**：凡是被填的字段都在 `inferred` 里，UI/调用方必须展示。

## 已知限制

- 重构是规则式的，不做语义推理：口语化、隐含需求（如"像 XX 那样"）识别不了，需要 agent 或用户补全。
- 窗口轮询间隔 2s，实时性要求更高时可改 SSE。
- 案例库是 markdown 单文件 + 追加写；极端并发（多会话同时沉淀）未加文件锁。

## 合规

Compliant with DSH Plugin Standard v2.0 — `npm run verify` 已通过。

License: MIT
