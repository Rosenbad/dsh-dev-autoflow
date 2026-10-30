// index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/workflow.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function findPackageRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "cordis.patch.yml"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}
var PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
var DEFAULT_SPEC_SCRIPT = join(PACKAGE_ROOT, "scripts", "spec_check.py");
var LEGACY_CASE_FILE = join(PACKAGE_ROOT, "references", "case-library.md");
function defaultDataDir() {
  const fromEnv = process.env.DSH_AUTOFLOW_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  return join(homedir(), ".dsh", "autoflow");
}
function defaultCaseFile() {
  return join(defaultDataDir(), "cases.md");
}
function resolveConfigPath(path) {
  return /^([a-zA-Z]:[\\/]|\/)/.test(path) ? resolve(path) : resolve(PACKAGE_ROOT, path);
}
var FIELD_ALIASES = {
  \u76EE\u6807: "\u76EE\u6807",
  \u53D7\u4F17: "\u53D7\u4F17",
  "\u53D7\u4F17/\u4F7F\u7528\u573A\u666F": "\u53D7\u4F17",
  \u4F7F\u7528\u573A\u666F: "\u53D7\u4F17",
  \u4EA4\u4ED8\u5F62\u6001: "\u4EA4\u4ED8\u5F62\u6001",
  \u6838\u5FC3\u529F\u80FD: "\u6838\u5FC3\u529F\u80FD",
  \u529F\u80FD: "\u6838\u5FC3\u529F\u80FD",
  \u8303\u56F4\u8FB9\u754C: "\u8303\u56F4\u8FB9\u754C",
  \u4E0D\u505A: "\u8303\u56F4\u8FB9\u754C",
  \u6280\u672F\u7EA6\u675F: "\u6280\u672F\u7EA6\u675F",
  \u9A8C\u6536\u6807\u51C6: "\u9A8C\u6536\u6807\u51C6",
  \u6210\u672C\u9884\u7B97: "\u6210\u672C\u9884\u7B97",
  \u5F85\u786E\u8BA4\u9879: "\u5F85\u786E\u8BA4\u9879"
};
var REQUIRED_FIELDS = ["\u76EE\u6807", "\u53D7\u4F17", "\u4EA4\u4ED8\u5F62\u6001", "\u6838\u5FC3\u529F\u80FD", "\u8303\u56F4\u8FB9\u754C", "\u6280\u672F\u7EA6\u675F", "\u9A8C\u6536\u6807\u51C6"];
var TESTABLE = new RegExp(
  [
    "\u80FD",
    "\u53EF",
    "\u6253\u5F00",
    "\u8FD0\u884C",
    "\u663E\u793A",
    "\u5C55\u793A",
    "\u8FD4\u56DE",
    "\u8F93\u51FA",
    "\u5237\u65B0",
    "\u751F\u6210",
    "\u89E3\u6790",
    "\u901A\u8FC7",
    "\u8FBE\u5230",
    "\u4E0D\u8D85\u8FC7",
    "\u4E0D\u5C11\u4E8E",
    "\u5927\u4E8E",
    "\u5C0F\u4E8E",
    "\u7B49\u4E8E",
    "\u8DD1\u901A",
    "\u6E32\u67D3",
    "\u70B9\u51FB",
    "\u5207\u6362",
    "\u63D0\u4EA4",
    "\u4FDD\u5B58",
    "\u4E0B\u8F7D",
    "\u5BFC\u51FA",
    "\u5BFC\u5165",
    "\u6D4B\u8BD5",
    "\u6821\u9A8C",
    "\\d+\\s*(?:ms|s|\u79D2|\u5206\u949F|\u6761|\u4E2A|\u9879|%|px|\u884C)",
    "pass",
    "fail",
    "verify"
  ].join("|"),
  "i"
);
function listItems(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "").map((line) => line.replace(/^(?:\d+[.)、]|[-*•])\s*/, "").trim()).filter((line) => line !== "");
}
function parseFields(text) {
  const fields = {};
  const push = (rawName, value) => {
    const name2 = FIELD_ALIASES[rawName.trim()] ?? rawName.trim();
    const next = value.trim();
    fields[name2] = fields[name2] ? `${fields[name2]}
${next}` : next;
  };
  const bracket = [...text.matchAll(/【([^】\n]+)】/g)];
  if (bracket.length > 0) {
    bracket.forEach((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = index + 1 < bracket.length ? bracket[index + 1].index ?? text.length : text.length;
      push(match[1], text.slice(start, end));
    });
    return fields;
  }
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current !== null) push(current, buffer.join("\n"));
    current = null;
    buffer = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const inline = line.match(/^\s*(?:#{1,6}\s*)?\*{0,2}([\u4e00-\u9fa5A-Za-z/]{1,12})\*{0,2}\s*[:：]\s*(.*)$/);
    const heading = line.match(/^\s*#{1,6}\s*([\u4e00-\u9fa5A-Za-z/]{1,12})\s*$/);
    const match = inline ?? heading;
    if (match) {
      flush();
      current = match[1];
      buffer = match[2] !== void 0 && match[2].trim() !== "" ? [match[2]] : [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return fields;
}
var DELIVERABLE_RULES = [
  { test: /静态网页|静态页|纯静态|单页应用|落地页/, label: "\u7F51\u9875\uFF08\u9759\u6001\uFF09" },
  { test: /看板|仪表盘|dashboard/i, label: "\u7F51\u9875\uFF08\u770B\u677F\uFF09" },
  { test: /小程序/, label: "\u5FAE\u4FE1\u5C0F\u7A0B\u5E8F" },
  { test: /网页|网站|官网|h5/i, label: "\u7F51\u9875" },
  { test: /web\s*应用|应用|系统|平台|后台|管理端/i, label: "Web \u5E94\u7528" },
  { test: /脚本|命令行|cli|批处理/i, label: "\u811A\u672C" },
  { test: /表格|excel|csv|xlsx|电子表/i, label: "\u8868\u683C" },
  { test: /ppt|幻灯片|演示文稿|slides?/i, label: "PPT" },
  { test: /文档|报告|合同|word/i, label: "\u6587\u6863" },
  { test: /图片|海报|封面|设计稿/, label: "\u56FE\u7247" },
  { test: /视频|短片|动画/, label: "\u89C6\u9891" }
];
var FEATURE_CUE = /能|可以|要|需要|支持|看到|查看|显示|统计|导出|导入|筛选|搜索|上传|下载|排序|计算|生成|预览|切换|登录|提醒|图表|对比|汇总/;
var NOT_A_FEATURE = /^(?:受众|用户|面向|给|不做|不包含|排除|技术|用|基于|数据来自|数据源|部署)/;
function detectDeliverable(raw) {
  for (const rule of DELIVERABLE_RULES) {
    if (rule.test.test(raw)) return rule.label;
  }
  return "";
}
function defaultAudience(deliverable) {
  if (/网页|小程序|应用/.test(deliverable)) return "\u6D4F\u89C8\u5668\u7528\u6237";
  if (/表格/.test(deliverable)) return "\u6570\u636E\u5206\u6790\u4EBA\u5458";
  if (/脚本/.test(deliverable)) return "\u547D\u4EE4\u884C\u4F7F\u7528\u8005";
  if (/PPT|文档/.test(deliverable)) return "\u6C47\u62A5\u53D7\u4F17";
  if (/图片/.test(deliverable)) return "\u8FD0\u8425/\u54C1\u724C";
  if (/视频/.test(deliverable)) return "\u5185\u5BB9\u53D7\u4F17";
  return "\u901A\u7528\u7528\u6237";
}
function cleanClause(text) {
  return text.replace(/^[\s，,。；;、]+/, "").replace(/^(?:并且|而且|同时|还|也|要|需要|能|可以|支持|希望|最好)+/, "").replace(/[\s，,。；;、]+$/, "").trim();
}
function acceptanceFor(feature, deliverable) {
  if (/导出|下载/.test(feature)) return `\u70B9\u51FB\u5BFC\u51FA\u80FD\u4E0B\u8F7D\u300C${feature}\u300D`;
  if (/上传|导入/.test(feature)) return `\u9009\u62E9\u6587\u4EF6\u4E0A\u4F20\u540E\u80FD\u770B\u5230\u5904\u7406\u7ED3\u679C`;
  if (/脚本/.test(deliverable)) {
    return /统计|计算|汇总|生成|处理/.test(feature) ? `\u8FD0\u884C\u811A\u672C\u540E\u80FD\u8F93\u51FA\u300C${feature}\u300D\u7684\u7ED3\u679C` : `\u8FD0\u884C\u811A\u672C\u540E\u80FD\u5B8C\u6210\u300C${feature}\u300D`;
  }
  if (/PPT|文档/.test(deliverable)) return `\u4EA4\u4ED8\u6587\u6863\u4E2D\u5305\u542B${feature}`;
  if (/表格/.test(deliverable)) return `\u8868\u683C\u4E2D\u80FD\u770B\u5230${feature}`;
  if (/^(?:看到|查看|显示|展示)/.test(feature)) return `\u6253\u5F00\u540E\u53EF${feature}`;
  if (/统计|图表|汇总|对比/.test(feature)) return `\u6253\u5F00\u540E\u53EF\u770B\u5230${feature}`;
  if (/筛选|搜索|切换|排序/.test(feature)) return `\u64CD\u4F5C\u300C${feature}\u300D\u540E\u7ED3\u679C\u5237\u65B0`;
  if (/计算|生成/.test(feature)) return `\u8FD0\u884C\u540E\u80FD\u8F93\u51FA\u300C${feature}\u300D\u7684\u7ED3\u679C`;
  return `\u80FD\u5B8C\u6210\u300C${feature}\u300D`;
}
var DEFAULT_BOUNDARY = "\u6309\u6700\u5C0F\u5B9E\u73B0\uFF1A\u4E0D\u505A\u767B\u5F55/\u6743\u9650\uFF0C\u4E0D\u505A\u540E\u7AEF\u4E0E\u6570\u636E\u5E93\uFF0C\u4E0D\u505A\u79FB\u52A8\u7AEF\u9002\u914D";
function defaultConstraint(deliverable) {
  if (/PPT|文档/.test(deliverable)) return "\u672A\u6307\u5B9A\uFF0C\u6309\u9ED8\u8BA4\uFF08\u6807\u51C6\u6A21\u677F\u3001\u65E0\u54C1\u724C\u89C4\u8303\uFF09";
  if (/表格/.test(deliverable)) return "\u672A\u6307\u5B9A\uFF0C\u6309\u9ED8\u8BA4\uFF08\u5355\u6587\u4EF6\u8868\u683C\u3001\u516C\u5F0F\u53EF\u590D\u6838\uFF09";
  if (/图片|视频/.test(deliverable)) return "\u672A\u6307\u5B9A\uFF0C\u6309\u9ED8\u8BA4\uFF08\u5355\u4EFD\u7D20\u6750\u3001\u4E0D\u4F7F\u7528\u7B2C\u4E09\u65B9\u7248\u6743\u7D20\u6750\uFF09";
  return "\u672A\u6307\u5B9A\uFF0C\u6309\u9ED8\u8BA4\uFF08\u9759\u6001\u5355\u6587\u4EF6\u3001\u65E0\u5916\u90E8\u4F9D\u8D56\uFF09";
}
function refineRequirement(raw) {
  const text = String(raw ?? "").trim();
  const inferred = [];
  const openQuestions = [];
  const clauses = text.split(/[。；;\n]/).flatMap((part) => part.split(/[，,]/)).map((part) => part.trim()).filter((part) => part !== "");
  const goalSource = clauses[0] ?? text;
  const goal = cleanClause(goalSource).replace(/^(?:帮我|帮忙|请|麻烦|我想|我要|想)+/, "").trim().slice(0, 120) || text.slice(0, 120);
  let deliverable = detectDeliverable(text);
  if (deliverable === "") {
    if (/统计|展示|看|浏览|界面|页面/.test(text)) deliverable = "\u7F51\u9875\uFF08\u9759\u6001\uFF09";
    else if (/计算|处理|批处理/.test(text)) deliverable = "\u811A\u672C";
    else deliverable = "\u672A\u6307\u5B9A\uFF08\u6309\u8DEF\u7531\u5224\u5B9A\uFF09";
    inferred.push("\u4EA4\u4ED8\u5F62\u6001");
    openQuestions.push("\u671F\u671B\u7684\u4EA4\u4ED8\u5F62\u6001\u662F\u4EC0\u4E48\uFF08\u7F51\u9875/\u811A\u672C/\u8868\u683C/\u6587\u6863/\u5DE5\u7A0B\u4EE3\u7801\uFF09\uFF1F");
  }
  let audience = text.match(/受众(?:是|为)?\s*[：:]?\s*([^\s，,。；;]+)/)?.[1] ?? text.match(/(?:面向|给)\s*([^\s，,。；;]{2,12}?)\s*(?:用|看|使用)/)?.[1] ?? "";
  if (audience === "") {
    audience = defaultAudience(deliverable);
    inferred.push("\u53D7\u4F17");
    openQuestions.push(`\u76EE\u6807\u53D7\u4F17\u9ED8\u8BA4\u6309\u300C${audience}\u300D\u5904\u7406\uFF0C\u662F\u5426\u6B63\u786E\uFF1F`);
  }
  const boundaries = [];
  for (const match of text.matchAll(/不做\s*([^。；;，,\n]+)/g)) {
    const item = match[1].trim();
    if (item !== "") boundaries.push(`\u4E0D\u505A${item}`);
  }
  for (const match of text.matchAll(/(?:不包含|排除)\s*([^。；;，,\n]+)/g)) {
    const item = match[1].trim();
    if (item !== "") boundaries.push(`\u4E0D\u5305\u542B${item}`);
  }
  if (boundaries.length === 0) {
    boundaries.push(DEFAULT_BOUNDARY);
    inferred.push("\u8303\u56F4\u8FB9\u754C");
    openQuestions.push("\u9ED8\u8BA4\u6309\u6700\u5C0F\u5B9E\u73B0\u6536\u655B\u8303\u56F4\uFF08\u4E0D\u505A\u767B\u5F55\u3001\u4E0D\u505A\u540E\u7AEF\u3001\u4E0D\u505A\u79FB\u52A8\u7AEF\u9002\u914D\uFF09\uFF0C\u9700\u8981\u653E\u5F00\u54EA\u4E00\u9879\uFF1F");
  }
  const constraints = [];
  const explicitConstraint = text.match(/(?:技术(?:约束|栈)?|技术方案)\s*[：:]?\s*([^。；;\n]+)/)?.[1];
  if (explicitConstraint !== void 0) constraints.push(cleanClause(explicitConstraint));
  const tooling = text.match(/(?:用|基于)\s*([^，,。；;\n]{2,20}?)\s*(?:做|实现|写|开发)/)?.[1];
  if (tooling !== void 0) constraints.push(`\u4F7F\u7528 ${cleanClause(tooling)}`);
  for (const match of text.matchAll(/(纯前端|无后端|离线|本地运行|单文件|不联网)/g)) constraints.push(match[1]);
  const dataSource = text.match(/数据(?:来自|来源)\s*([^，,。；;\n]+)/)?.[1];
  if (dataSource !== void 0) constraints.push(`\u6570\u636E\u6765\u81EA ${cleanClause(dataSource)}`);
  if (constraints.length === 0) {
    constraints.push(defaultConstraint(deliverable));
    inferred.push("\u6280\u672F\u7EA6\u675F");
  }
  const features = [];
  for (const clause of clauses) {
    if (NOT_A_FEATURE.test(clause)) continue;
    if (!FEATURE_CUE.test(clause)) continue;
    const feature = cleanClause(clause);
    if (feature.length < 2) continue;
    if (features.some((item) => item === feature || item.includes(feature))) continue;
    features.push(feature);
    if (features.length >= 8) break;
  }
  if (features.length === 0) {
    openQuestions.push("\u8FD9\u4E2A\u9700\u6C42\u5FC5\u987B\u505A\u5230\u54EA\u51E0\u4EF6\u4E8B\uFF1F\u8BF7\u5217\u51FA 2~5 \u6761\u6838\u5FC3\u529F\u80FD\u3002");
  }
  const acceptance = features.map((feature) => acceptanceFor(feature, deliverable));
  if (acceptance.length > 0) inferred.push("\u9A8C\u6536\u6807\u51C6\uFF08\u6309\u6838\u5FC3\u529F\u80FD\u63A8\u5BFC\uFF09");
  return {
    goal,
    audience,
    deliverable,
    features,
    boundaries,
    constraints,
    acceptance,
    costNote: "\u672A\u4F30\u8BA1",
    openQuestions,
    inferred
  };
}
function runProcess(bin, args, input, timeoutMs) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    };
    const child = spawn(bin, args, { windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += String(error.message);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {
    });
    child.stdin?.end(input, "utf8");
  });
}
function parseCheckerOutput(output) {
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim()).filter((line) => line !== "");
}
var cachedInterpreter;
async function detectInterpreter() {
  if (cachedInterpreter !== void 0) return cachedInterpreter;
  const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  for (const bin of candidates) {
    const outcome = await runProcess(bin, ["--version"], "", 5e3);
    if (outcome.code === 0 && /python/i.test(`${outcome.stdout}${outcome.stderr}`)) {
      cachedInterpreter = bin;
      return bin;
    }
  }
  cachedInterpreter = null;
  return null;
}
async function runSpecCheck(specText, scriptPath = DEFAULT_SPEC_SCRIPT, opts = {}) {
  const structural = structuralCheck(specText);
  if (!structural.ok) return structural;
  const bin = opts.bin ?? await detectInterpreter();
  if (bin === null) {
    return { ok: true, degraded: true, problems: ["\u672A\u627E\u5230 python \u89E3\u91CA\u5668\uFF0C\u4EC5\u901A\u8FC7\u7ED3\u6784\u68C0\u67E5\uFF08degraded\uFF09"] };
  }
  const outcome = await runProcess(bin, [scriptPath, "-"], specText, opts.timeoutMs ?? 15e3);
  if (outcome.code === 0) return { ok: true, problems: [] };
  if (outcome.code === 1) {
    const problems = parseCheckerOutput(`${outcome.stdout}
${outcome.stderr}`);
    return { ok: false, problems: problems.length > 0 ? problems : ["\u89C4\u683C\u6821\u9A8C\u672A\u901A\u8FC7\uFF08\u6821\u9A8C\u5668\u672A\u7ED9\u51FA\u660E\u7EC6\uFF09"] };
  }
  const reason = outcome.timedOut ? "\u6821\u9A8C\u5668\u8D85\u65F6" : `\u6821\u9A8C\u5668\u65E0\u6CD5\u6267\u884C\uFF08${outcome.stderr.trim().slice(0, 80) || "unknown error"}\uFF09`;
  return { ok: true, degraded: true, problems: [`${reason}\uFF0C\u4EC5\u901A\u8FC7\u7ED3\u6784\u68C0\u67E5\uFF08degraded\uFF09`] };
}
function structuralCheck(text) {
  const problems = [];
  const fields = parseFields(text);
  for (const field of REQUIRED_FIELDS) {
    if ((fields[field] ?? "").trim() === "") problems.push(`\u7F3A\u5C11\u6216\u4E3A\u7A7A: \u3010${field}\u3011`);
  }
  const boundary = (fields["\u8303\u56F4\u8FB9\u754C"] ?? "").trim();
  if (boundary !== "") {
    const declaresOutOfScope = /不做|不包含|不支持|不涉及|排除/.test(boundary);
    const isPlaceholder = /^(暂无|无|待定|未声明|略)$/.test(boundary);
    if (!declaresOutOfScope || isPlaceholder) {
      problems.push('\u3010\u8303\u56F4\u8FB9\u754C\u3011\u672A\u58F0\u660E"\u4E0D\u505A"\u7684\u5185\u5BB9\uFF08\u5199"\u65E0/\u6682\u65E0"\u4E0D\u7B97\u58F0\u660E\uFF0C\u8BF7\u660E\u786E\u6392\u9664\u9879\uFF09');
    }
  }
  const features = listItems(fields["\u6838\u5FC3\u529F\u80FD"] ?? "");
  const accepts = listItems(fields["\u9A8C\u6536\u6807\u51C6"] ?? "");
  if (accepts.length > 0) {
    if (features.length > 0 && accepts.length < features.length) {
      problems.push(`\u9A8C\u6536\u6807\u51C6(${accepts.length}\u6761)\u5C11\u4E8E\u6838\u5FC3\u529F\u80FD(${features.length}\u6761)\uFF1A\u6BCF\u6761\u529F\u80FD\u90FD\u5E94\u6709\u5BF9\u5E94\u9A8C\u6536\u6807\u51C6`);
    }
    for (const line of accepts) {
      if (!TESTABLE.test(line)) problems.push(`\u9A8C\u6536\u6807\u51C6\u4E0D\u53EF\u6D4B(\u7F3A\u53EF\u9A8C\u8BC1\u52A8\u8BCD): ${line.slice(0, 60)}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
var ROUTE_RULES = [
  {
    test: /单页|静态|展示|看板|可视化报告|落地页|官网|dashboard|landing/,
    channel: () => ({ kind: "skill", skill: "html / doubao-visualization", reason: "\u9759\u6001\u5C55\u793A\u578B\u9875\u9762\u8D70 html\uFF0C\u5FEB\u4E14\u7701" })
  },
  {
    test: /应用|系统|平台|webapp|全栈|管理后台|数据库|登录/,
    channel: () => ({ kind: "skill", skill: "doubao-app-builder (webapp)", reason: "\u591A\u6587\u4EF6\u5DE5\u7A0B\u8D70 app-builder" })
  },
  {
    test: /表格|excel|csv|xlsx|数据|分析|sheet/,
    channel: () => ({ kind: "skill", skill: "sheet / doubao-data-analysis", reason: "\u8868\u683C\u4E0E\u6570\u636E\u5206\u6790\u6709\u4E13\u6709 skill" })
  },
  {
    test: /文档|doc|word|报告|合同/,
    channel: () => ({ kind: "skill", skill: "word / lark-doc / doubao-contract-drafting", reason: "\u6587\u6863\u7C7B\u8D70\u4E13\u6709 skill" })
  },
  {
    test: /ppt|幻灯片|slide|演示/,
    channel: () => ({ kind: "skill", skill: "ppt", reason: "\u5E7B\u706F\u7247\u5168\u6D41\u7A0B" })
  },
  {
    test: /图片|海报|设计|视觉|logo/,
    channel: () => ({ kind: "skill", skill: "doubao-creative-design", reason: "\u89C6\u89C9\u521B\u4F5C\u6709\u4E13\u6709\u6D41\u7A0B" })
  },
  {
    test: /视频|短片|动画/,
    channel: () => ({ kind: "skill", skill: "doubao-creative-video", reason: "\u89C6\u9891\u521B\u4F5C\u6709\u4E13\u6709\u6D41\u7A0B" })
  }
];
function routeChannel(spec, featureCount) {
  const deliverable = (spec.deliverable ?? "").toLowerCase();
  const goal = (spec.goal ?? "").toLowerCase();
  const features = typeof featureCount === "number" ? Math.max(0, featureCount) : spec.features?.length ?? 0;
  const multiSignal = /调研|对比|多通道|多平台|系统分析|深度|全面|竞品|多场景|research|compare/.test(goal);
  if (multiSignal && features >= 3) {
    return { kind: "organize", reason: "\u591A\u901A\u9053/\u591A\u573A\u666F\u4FE1\u53F7 + \u529F\u80FD\u62C6\u89E3 \u22653\uFF0C\u59D4\u6D3E OrganizeAgent \u5E76\u884C" };
  }
  for (const rule of ROUTE_RULES) {
    if (rule.test.test(deliverable)) return rule.channel();
  }
  return { kind: "direct", reason: "\u5355\u6587\u4EF6/\u5355\u4EFB\u52A1\uFF0CMainAgent \u76F4\u63A5\u6267\u884C\u6700\u7701\u6210\u672C" };
}
var CASE_HEADER = "# \u4EFB\u52A1\u7ECF\u9A8C\u6C89\u6DC0\u5E93\n\n";
var CASE_HEADING = /^### 案例 (\d+)：([^\n]*)$/gm;
function sanitizeField(value, maxLen = 300) {
  return String(value ?? "").replace(/\r?\n+/g, " ").replace(/[#`*>]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}
async function loadCases(caseFile) {
  try {
    const text = await readFile(caseFile, "utf8");
    const heads = [];
    CASE_HEADING.lastIndex = 0;
    let match;
    while ((match = CASE_HEADING.exec(text)) !== null) {
      heads.push({
        id: Number(match[1]),
        summary: match[2].trim(),
        start: match.index,
        end: match.index + match[0].length
      });
    }
    return heads.map((head, index) => {
      const block = text.slice(head.end, index + 1 < heads.length ? heads[index + 1].start : text.length);
      const field = (label) => block.match(new RegExp(`${label}\uFF1A(.+)`))?.[1]?.trim() ?? "";
      return {
        id: head.id,
        date: field("\u65E5\u671F"),
        summary: head.summary,
        channel: field("\u6267\u884C\u901A\u9053"),
        deliverable: field("\u4EA4\u4ED8\u5F62\u6001"),
        result: field("\u7ED3\u679C"),
        lesson: field("\u6559\u8BAD")
      };
    });
  } catch {
    return [];
  }
}
async function appendCase(caseFile, record) {
  const records = await loadCases(caseFile);
  const nextId = records.reduce((max, item) => Math.max(max, Number.isFinite(item.id) ? item.id : 0), 0) + 1;
  const clean = {
    date: sanitizeField(record.date, 20),
    summary: sanitizeField(record.summary, 160),
    channel: sanitizeField(record.channel, 60),
    deliverable: sanitizeField(record.deliverable, 60),
    result: sanitizeField(record.result, 120),
    lesson: sanitizeField(record.lesson, 240)
  };
  if (clean.summary === "") throw new Error("summary \u4E0D\u80FD\u4E3A\u7A7A");
  const entry = [
    `### \u6848\u4F8B ${nextId}\uFF1A${clean.summary}`,
    `- \u65E5\u671F\uFF1A${clean.date}`,
    `- \u9700\u6C42\u8981\u70B9\uFF1A${clean.summary}`,
    `- \u6267\u884C\u901A\u9053\uFF1A${clean.channel}`,
    `- \u4EA4\u4ED8\u5F62\u6001\uFF1A${clean.deliverable}`,
    `- \u7ED3\u679C\uFF1A${clean.result}`,
    `- \u6559\u8BAD\uFF1A${clean.lesson}`,
    "",
    ""
  ].join("\n");
  await mkdir(dirname(resolve(caseFile)), { recursive: true });
  let needsHeader = false;
  try {
    needsHeader = (await stat(caseFile)).size === 0;
  } catch {
    needsHeader = true;
  }
  await appendFile(caseFile, (needsHeader ? CASE_HEADER : "") + entry, "utf8");
  return { id: nextId, ...clean };
}
async function ensureCaseFile(caseFile, legacyFile) {
  try {
    await access(caseFile);
    return caseFile;
  } catch {
  }
  if (legacyFile !== void 0) {
    try {
      const legacy = await readFile(legacyFile, "utf8");
      if (/### 案例 \d+：/.test(legacy)) {
        await mkdir(dirname(resolve(caseFile)), { recursive: true });
        await writeFile(caseFile, legacy, "utf8");
      }
    } catch {
    }
  }
  return caseFile;
}
function buildSpecText(spec) {
  return [
    `\u3010\u76EE\u6807\u3011${spec.goal}`,
    `\u3010\u53D7\u4F17\u3011${spec.audience}`,
    `\u3010\u4EA4\u4ED8\u5F62\u6001\u3011${spec.deliverable}`,
    `\u3010\u6838\u5FC3\u529F\u80FD\u3011${spec.features.map((f, i) => `
${i + 1}. ${f}`).join("")}`,
    `\u3010\u8303\u56F4\u8FB9\u754C\u3011${spec.boundaries.join("\uFF1B")}`,
    `\u3010\u6280\u672F\u7EA6\u675F\u3011${spec.constraints.join("\uFF1B")}`,
    `\u3010\u9A8C\u6536\u6807\u51C6\u3011${spec.acceptance.map((a, i) => `
${i + 1}. ${a}`).join("")}`,
    `\u3010\u6210\u672C\u9884\u7B97\u3011${spec.costNote}`,
    `\u3010\u5F85\u786E\u8BA4\u9879\u3011${spec.openQuestions.join("\uFF1B")}`
  ].join("\n");
}
async function runPipeline(raw, opts = {}) {
  const spec = refineRequirement(raw);
  const caseFile = resolve(opts.caseFile ?? defaultCaseFile());
  const cases = await loadCases(caseFile);
  const channel = routeChannel(spec, spec.features.length);
  const check = await runSpecCheck(buildSpecText(spec), opts.specScript ? resolve(opts.specScript) : DEFAULT_SPEC_SCRIPT);
  return {
    spec,
    check,
    channel,
    cases,
    inferred: spec.inferred ?? [],
    questions: spec.openQuestions
  };
}

// index.ts
var name = "dsh-dev-autoflow";
var inject = ["webServer", "tools"];
var PIPELINE_STEPS = [
  { key: "spec", label: "\u9700\u6C42\u91CD\u6784" },
  { key: "check", label: "\u89C4\u683C\u786C\u6821\u9A8C" },
  { key: "route", label: "\u901A\u9053\u8DEF\u7531" },
  { key: "execute", label: "\u6267\u884C\u9A8C\u8BC1" },
  { key: "case", label: "\u6848\u4F8B\u6C89\u6DC0" }
];
var progressBySession = /* @__PURE__ */ new Map();
var lastSessionKey = "default";
function makeSteps() {
  return PIPELINE_STEPS.map((step) => ({
    key: step.key,
    label: step.label,
    status: "pending",
    note: "",
    updatedAt: 0
  }));
}
function stateOf(sessionKey) {
  let state = progressBySession.get(sessionKey);
  if (state === void 0) {
    state = { active: false, steps: makeSteps(), updatedAt: 0 };
    progressBySession.set(sessionKey, state);
    if (progressBySession.size > 32) {
      const oldest = [...progressBySession.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest !== void 0) progressBySession.delete(oldest[0]);
    }
  }
  return state;
}
function resetProgress(sessionKey = "default") {
  lastSessionKey = sessionKey;
  progressBySession.set(sessionKey, { active: true, steps: makeSteps(), updatedAt: Date.now() });
}
function ensureRun(sessionKey) {
  if (!stateOf(sessionKey).active) resetProgress(sessionKey);
}
function setStepState(sessionKey, key, status, note) {
  const state = stateOf(sessionKey);
  const step = state.steps.find((item) => item.key === key);
  if (step === void 0) return;
  step.status = status;
  if (note !== void 0) step.note = note;
  step.updatedAt = Date.now();
  state.updatedAt = Date.now();
}
function finishProgress(sessionKey, failed = false) {
  const state = stateOf(sessionKey);
  state.active = false;
  for (const step of state.steps) {
    if (step.status === "active") {
      step.status = failed ? "fail" : "done";
      step.updatedAt = Date.now();
    }
  }
  state.updatedAt = Date.now();
}
function currentProgress(sessionKey = lastSessionKey) {
  const state = stateOf(sessionKey);
  return { active: state.active, steps: state.steps.map((step) => ({ ...step })) };
}
function sessionOf(exec) {
  const agent = exec?.agent;
  const id = agent?.id;
  return typeof id === "string" && id !== "" ? id : "default";
}
function apply(ctx, config) {
  const specScript = config?.specScript === void 0 ? DEFAULT_SPEC_SCRIPT : resolveConfigPath(config.specScript);
  const caseFile = config?.caseFile === void 0 ? defaultCaseFile() : resolveConfigPath(config.caseFile);
  if (config?.caseFile === void 0) {
    void ensureCaseFile(caseFile, LEGACY_CASE_FILE).catch(() => void 0);
  }
  ctx.tools?.register?.(defineTool({
    name: "autoflow_spec_check",
    description: '\u5F00\u53D1\u81EA\u52A8\u6D41\uFF1A\u5BF9\u9700\u6C42\u89C4\u683C\u6587\u672C\u505A\u786C\u6821\u9A8C\uFF08\u5FC5\u586B\u5B57\u6BB5\u9F50\u5168\u4E14\u975E\u7A7A\u3001\u9A8C\u6536\u6807\u51C6\u53EF\u6D4B\u3001\u8303\u56F4\u8FB9\u754C\u58F0\u660E"\u4E0D\u505A"\uFF09\u3002\u8FD4\u56DE PASS/FAIL \u4E0E\u95EE\u9898\u6E05\u5355\uFF1B\u6821\u9A8C\u5668\u4E0D\u53EF\u7528\u65F6\u8FD4\u56DE degraded\u3002\u89C4\u683C\u5B9A\u7A3F\u524D\u8C03\u7528\u4E00\u6B21\u3002',
    parameters: {
      spec: { type: "string", description: "\u89C4\u683C\u6587\u672C\uFF0C\u542B\u3010\u76EE\u6807\u3011\u3010\u53D7\u4F17\u3011\u3010\u4EA4\u4ED8\u5F62\u6001\u3011\u3010\u6838\u5FC3\u529F\u80FD\u3011\u3010\u8303\u56F4\u8FB9\u754C\u3011\u3010\u6280\u672F\u7EA6\u675F\u3011\u3010\u9A8C\u6536\u6807\u51C6\u3011\u7B49\u5B57\u6BB5\u3002" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean", required: true, description: "\u6821\u9A8C\u662F\u5426\u901A\u8FC7\u3002" },
          problems: { type: "array", required: true, items: { type: "string" }, description: "\u672A\u901A\u8FC7\u65F6\u7684\u95EE\u9898\u6E05\u5355\u3002" },
          degraded: { type: "boolean", description: "\u786E\u5B9A\u6027\u6821\u9A8C\u5668\u4E0D\u53EF\u7528\uFF0C\u4EC5\u901A\u8FC7\u7ED3\u6784\u68C0\u67E5\u3002" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.ok ? value.degraded === true ? `\u89C4\u683C\u4EC5\u901A\u8FC7\u7ED3\u6784\u68C0\u67E5\uFF08\u786E\u5B9A\u6027\u6821\u9A8C\u5668\u4E0D\u53EF\u7528\uFF0C\u964D\u7EA7\u4E3A\u8F6F\u901A\u8FC7\uFF09
${value.problems.map((p) => `- ${p}`).join("\n")}` : "\u89C4\u683C\u786C\u6821\u9A8C\u901A\u8FC7 \u2713\uFF08\u5FC5\u586B\u5B57\u6BB5\u9F50\u5168\u4E14\u975E\u7A7A\u3001\u9A8C\u6536\u6807\u51C6\u53EF\u6D4B\u3001\u8303\u56F4\u8FB9\u754C\u5DF2\u58F0\u660E\uFF09" : `\u89C4\u683C\u786C\u6821\u9A8C\u672A\u901A\u8FC7 \u2717
${value.problems.map((p) => `- ${p}`).join("\n")}`
        }
      ]
    },
    execute: async (args, exec) => {
      const session = sessionOf(exec);
      const text = typeof args?.spec === "string" && args.spec.trim() !== "" ? args.spec : "";
      if (text === "") {
        ensureRun(session);
        setStepState(session, "check", "fail", "\u7F3A\u5C11\u89C4\u683C\u6587\u672C");
        return { ok: false, problems: ["\u7F3A\u5C11\u89C4\u683C\u6587\u672C\uFF08spec \u53C2\u6570\u4E3A\u7A7A\uFF09"] };
      }
      ensureRun(session);
      setStepState(session, "check", "active", "\u6B63\u5728\u786C\u6821\u9A8C\u89C4\u683C\u2026");
      const check = await runSpecCheck(text, specScript);
      if (check.ok) {
        setStepState(session, "check", "done", check.degraded === true ? "\u7ED3\u6784\u68C0\u67E5\u901A\u8FC7\uFF08\u6821\u9A8C\u5668\u4E0D\u53EF\u7528\uFF09" : "\u89C4\u683C\u786C\u6821\u9A8C\u901A\u8FC7");
        setStepState(session, "spec", "done", "\u9700\u6C42\u91CD\u6784\u5B8C\u6210");
      } else {
        setStepState(session, "check", "fail", check.problems[0] ?? "\u89C4\u683C\u6821\u9A8C\u5931\u8D25");
      }
      return { ok: check.ok, problems: check.problems, degraded: check.degraded === true };
    }
  }));
  ctx.tools?.register?.(defineTool({
    name: "autoflow_route",
    description: "\u5F00\u53D1\u81EA\u52A8\u6D41\uFF1A\u6839\u636E\u9700\u6C42\u89C4\u683C\u63A8\u8350\u6267\u884C\u901A\u9053\uFF08direct=\u76F4\u63A5\u6267\u884C / skill=\u52A0\u8F7D\u672C\u5730 skill / organize=\u59D4\u6D3E OrganizeAgent\uFF09\u3002\u6309\u4EA4\u4ED8\u5F62\u6001\u4E0E\u89C4\u6A21\xD7\u590D\u6742\u5EA6\u5224\u5B9A\uFF0C\u8FD4\u56DE\u901A\u9053\u4E0E\u7406\u7531\u3002",
    parameters: {
      deliverable: { type: "string", description: "\u4EA4\u4ED8\u5F62\u6001\uFF0C\u5982\uFF1A\u7F51\u9875/\u811A\u672C/\u8868\u683C/\u6587\u6863/PPT/\u5DE5\u7A0B\u4EE3\u7801/\u62A5\u544A\u3002" },
      goal: { type: "string", description: "\u4E00\u53E5\u8BDD\u76EE\u6807\u63CF\u8FF0\u3002" },
      featureCount: { type: "number", description: "\u6838\u5FC3\u529F\u80FD\u6761\u6570\uFF083~8 \u6761\u4E3A\u5178\u578B\uFF09\u3002" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          channel: { type: "string", required: true, enum: ["direct", "skill", "organize", "explore"], description: "\u63A8\u8350\u901A\u9053\u3002" },
          skill: { type: "string", description: "channel=skill \u65F6\u7684 skill \u540D\u3002" },
          reason: { type: "string", required: true, description: "\u8DEF\u7531\u7406\u7531\u3002" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `\u63A8\u8350\u6267\u884C\u901A\u9053\uFF1A${value.channel}${value.skill ? `\uFF08${value.skill}\uFF09` : ""}
\u7406\u7531\uFF1A${value.reason}`
        }
      ]
    },
    execute: async (args, exec) => {
      const session = sessionOf(exec);
      const spec = {
        deliverable: typeof args?.deliverable === "string" ? args.deliverable : "\u672A\u6307\u5B9A",
        goal: typeof args?.goal === "string" ? args.goal : "",
        features: []
      };
      const featureCount = Number.isFinite(args?.featureCount) ? Number(args?.featureCount) : void 0;
      const channel = routeChannel(spec, featureCount);
      ensureRun(session);
      setStepState(session, "route", "done", channelReason(channel));
      return { channel: channel.kind, skill: channel.kind === "skill" ? channel.skill : void 0, reason: channel.reason };
    }
  }));
  ctx.tools?.register?.(defineTool({
    name: "autoflow_report_step",
    description: "\u5F00\u53D1\u81EA\u52A8\u6D41\uFF1A\u4E0A\u62A5\u6D41\u6C34\u7EBF\u67D0\u4E00\u6B65\u7684\u771F\u5B9E\u8FDB\u5C55\uFF08\u5C24\u5176 execute \u6267\u884C\u9A8C\u8BC1\uFF1A\u5F00\u5DE5\u524D\u62A5 active\uFF0C\u4EA4\u4ED8\u540E\u62A5 done/fail\uFF09\u3002\u53EA\u4E0A\u62A5\u4F60\u5B9E\u9645\u505A\u8FC7\u7684\u4E8B\uFF0C\u4E0D\u8981\u9884\u8BBE\u5B8C\u6210\u3002",
    parameters: {
      key: { type: "string", description: "\u6B65\u9AA4 key\uFF1Aspec / check / route / execute / case\u3002" },
      status: { type: "string", description: "\u72B6\u6001\uFF1Aactive\uFF08\u8FDB\u884C\u4E2D\uFF09/ done\uFF08\u5B8C\u6210\uFF09/ fail\uFF08\u5931\u8D25\uFF09/ skipped\uFF08\u672C\u6B21\u8DF3\u8FC7\uFF09\u3002" },
      note: { type: "string", description: '\u4E00\u53E5\u8BDD\u8FDB\u5C55\u8BF4\u660E\uFF0C\u5982"\u5DF2\u751F\u6210 3 \u4E2A\u6587\u4EF6\u5E76\u8DD1\u901A\u672C\u5730\u9884\u89C8"\u3002' }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean", required: true },
          key: { type: "string", required: true },
          status: { type: "string", required: true },
          message: { type: "string" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [
        { type: "text", text: value.ok ? `\u5DF2\u8BB0\u5F55\uFF1A${value.key} \u2192 ${value.status}` : `\u4E0A\u62A5\u5931\u8D25\uFF1A${value.message ?? "\u672A\u77E5\u9519\u8BEF"}` }
      ]
    },
    execute: async (args, exec) => {
      const session = sessionOf(exec);
      const key = typeof args?.key === "string" ? args.key : "";
      const status = typeof args?.status === "string" ? args.status : "";
      const allowedKeys = PIPELINE_STEPS.map((step) => step.key);
      const allowedStatus = ["active", "done", "fail", "skipped"];
      if (!allowedKeys.includes(key)) {
        return { ok: false, key, status, message: `key \u5FC5\u987B\u662F ${allowedKeys.join(" / ")}` };
      }
      if (!allowedStatus.includes(status)) {
        return { ok: false, key, status, message: `status \u5FC5\u987B\u662F ${allowedStatus.join(" / ")}` };
      }
      ensureRun(session);
      setStepState(session, key, status, typeof args?.note === "string" ? args.note.slice(0, 200) : "");
      return { ok: true, key, status };
    }
  }));
  ctx.tools?.register?.(defineTool({
    name: "autoflow_append_case",
    description: "\u5F00\u53D1\u81EA\u52A8\u6D41\uFF1A\u4EFB\u52A1\u5B8C\u6210\u540E\u628A\u7ECF\u9A8C\u6C89\u6DC0\u8FDB\u6848\u4F8B\u5E93\uFF08\u6458\u8981/\u6267\u884C\u901A\u9053/\u4EA4\u4ED8\u5F62\u6001/\u7ED3\u679C/\u6559\u8BAD\uFF09\uFF0C\u4F9B\u540E\u7EED\u4EFB\u52A1\u590D\u7528\u3002\u6BCF\u5B8C\u6210\u4E00\u4E2A\u5F00\u53D1\u4EFB\u52A1\u8C03\u7528\u4E00\u6B21\u3002",
    parameters: {
      summary: { type: "string", description: "\u4EFB\u52A1\u6458\u8981\uFF0C\u4E00\u53E5\u8BDD\u3002" },
      channel: { type: "string", description: "\u6267\u884C\u901A\u9053\uFF1Adirect / skill:<\u540D\u79F0> / organize\u3002" },
      deliverable: { type: "string", description: "\u4EA4\u4ED8\u5F62\u6001\u3002" },
      result: { type: "string", description: "\u7ED3\u679C\uFF1A\u6210\u529F / \u90E8\u5206\u6210\u529F / \u5931\u8D25 + \u4E00\u53E5\u8BDD\u8BF4\u660E\u3002" },
      lesson: { type: "string", description: "\u6559\u8BAD/\u7ECF\u9A8C\uFF0C\u4E00\u53E5\u8BDD\u3002" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean", required: true },
          created: {
            type: "object",
            properties: {
              id: { type: "number", required: true },
              summary: { type: "string", required: true }
            },
            additionalProperties: false
          },
          message: { type: "string" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.ok && value.created ? `\u6848\u4F8B #${value.created.id} \u5DF2\u6C89\u6DC0\uFF1A${value.created.summary}` : `\u6848\u4F8B\u6C89\u6DC0\u5931\u8D25\uFF1A${value.message ?? "\u672A\u77E5\u9519\u8BEF"}`
        }
      ]
    },
    execute: async (args, exec) => {
      const session = sessionOf(exec);
      if (typeof args?.summary !== "string" || args.summary.trim() === "") {
        return { ok: false, message: "summary \u5FC5\u586B" };
      }
      const created = await appendCase(caseFile, {
        date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
        summary: args.summary.trim(),
        channel: typeof args.channel === "string" ? args.channel : "",
        deliverable: typeof args.deliverable === "string" ? args.deliverable : "",
        result: typeof args.result === "string" ? args.result : "\u6210\u529F",
        lesson: typeof args.lesson === "string" ? args.lesson : "\u65E0"
      });
      ensureRun(session);
      setStepState(session, "case", "done", `\u6848\u4F8B #${created.id} \u5DF2\u6C89\u6DC0`);
      finishProgress(session);
      return { ok: true, created: { id: created.id, summary: created.summary } };
    }
  }));
  const webServer = ctx.webServer;
  if (webServer === void 0) return;
  const handler = (req, res) => {
    return (async () => {
      await handleApi(req, res, { specScript, caseFile });
    })();
  };
  ctx.effect?.(
    () => webServer.register({ kind: "prefix", path: "/api/autoflow", handler }),
    "dsh-dev-autoflow: api routes"
  );
  ctx.logger?.info?.(`dsh-dev-autoflow: API ready at /api/autoflow/*; tools registered; cases \u2192 ${caseFile}`);
}
var pipelineRunning = false;
async function handleApi(req, res, opts) {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return sendJson(res, 400, { ok: false, message: "invalid url" });
  }
  const { pathname } = url;
  const session = url.searchParams.get("session") ?? lastSessionKey;
  try {
    if (req.method === "GET" && (pathname === "/api/autoflow/state" || pathname === "/api/autoflow/status")) {
      const cases = await loadCases(opts.caseFile);
      return sendJson(res, 200, {
        ok: true,
        session,
        pipeline: PIPELINE_STEPS.map((step) => step.label),
        caseCount: cases.length,
        cases,
        progress: currentProgress(session)
      });
    }
    if (req.method === "GET" && pathname === "/api/autoflow/progress") {
      return sendJson(res, 200, { ok: true, session, progress: currentProgress(session) });
    }
    if (req.method === "GET" && pathname === "/api/autoflow/cases") {
      const cases = await loadCases(opts.caseFile);
      return sendJson(res, 200, { ok: true, cases });
    }
    if (req.method === "POST" && pathname === "/api/autoflow/run") {
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, message: "untrusted origin" });
      if (!isJsonRequest(req)) return sendJson(res, 415, { ok: false, message: "content-type must be application/json" });
      if (pipelineRunning) return sendJson(res, 409, { ok: false, message: "a pipeline run is already in progress" });
      const body = await readJsonBody(req);
      const raw = typeof body?.raw === "string" ? body.raw.trim() : "";
      if (raw === "") return sendJson(res, 400, { ok: false, message: "raw requirement is required" });
      if (raw.length > 2e4) return sendJson(res, 413, { ok: false, message: "raw requirement is too long (max 20000 chars)" });
      pipelineRunning = true;
      resetProgress(session);
      setStepState(session, "spec", "active", "\u6B63\u5728\u91CD\u6784\u9700\u6C42\u89C4\u683C\u2026");
      try {
        const result = await runPipeline(raw, opts);
        const assumptionNote = result.inferred.length > 0 ? `\uFF08${result.inferred.length} \u9879\u5047\u8BBE\uFF09` : "";
        setStepState(session, "spec", "done", `\u9700\u6C42\u91CD\u6784\u5B8C\u6210${assumptionNote}`);
        setStepState(
          session,
          "check",
          result.check.ok ? "done" : "fail",
          result.check.ok ? result.check.degraded === true ? "\u7ED3\u6784\u68C0\u67E5\u901A\u8FC7\uFF08\u6821\u9A8C\u5668\u4E0D\u53EF\u7528\uFF09" : "\u89C4\u683C\u786C\u6821\u9A8C\u901A\u8FC7" : result.check.problems[0] ?? "\u89C4\u683C\u6821\u9A8C\u5931\u8D25"
        );
        setStepState(session, "route", "done", channelReason(result.channel));
        setStepState(session, "execute", "skipped", "\u8BE5\u5165\u53E3\u53EA\u4EA7\u51FA\u89C4\u683C/\u6821\u9A8C/\u8DEF\u7531\uFF0C\u4E0D\u6267\u884C\u4EA4\u4ED8");
        finishProgress(session, !result.check.ok);
        return sendJson(res, 200, {
          ok: true,
          session,
          specOk: result.check.ok,
          inferred: result.inferred,
          questions: result.questions,
          result
        });
      } catch (error) {
        finishProgress(session, true);
        return sendJson(res, 500, { ok: false, message: errorMessage(error) });
      } finally {
        pipelineRunning = false;
      }
    }
    if (req.method === "POST" && pathname === "/api/autoflow/cases") {
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, message: "untrusted origin" });
      if (!isJsonRequest(req)) return sendJson(res, 415, { ok: false, message: "content-type must be application/json" });
      const body = await readJsonBody(req);
      const record = body?.record;
      if (!record || typeof record.summary !== "string") {
        return sendJson(res, 400, { ok: false, message: "record.summary is required" });
      }
      const created = await appendCase(opts.caseFile, {
        date: record.date ?? (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
        summary: record.summary,
        channel: record.channel ?? "",
        deliverable: record.deliverable ?? "",
        result: record.result ?? "\u6210\u529F",
        lesson: record.lesson ?? "\u65E0"
      });
      return sendJson(res, 200, { ok: true, created });
    }
    sendJson(res, 404, { ok: false, message: "not found" });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: errorMessage(error) });
  }
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function isJsonRequest(req) {
  const contentType = String(req.headers["content-type"] ?? "");
  return contentType.toLowerCase().includes("application/json");
}
function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolvePromise(text === "" ? {} : JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": data.length
  });
  res.end(data);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function channelReason(channel) {
  switch (channel.kind) {
    case "direct":
      return channel.reason;
    case "skill":
      return `${channel.skill}\uFF1A${channel.reason}`;
    case "organize":
      return channel.reason;
    case "explore":
      return channel.reason;
  }
}
export {
  apply,
  currentProgress,
  finishProgress,
  inject,
  name,
  resetProgress,
  setStepState
};
