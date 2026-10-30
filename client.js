window.__ModuleLoader__.load({ id: 'dsh-dev-autoflow', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots"];
var STATUS_TEXT = {
  pending: "\u5F85\u6267\u884C",
  active: "\u6267\u884C\u4E2D",
  done: "\u5B8C\u6210",
  fail: "\u5931\u8D25",
  skipped: "\u5DF2\u8DF3\u8FC7"
};
var FALLBACK_STEPS = [
  { key: "spec", label: "\u9700\u6C42\u91CD\u6784" },
  { key: "check", label: "\u89C4\u683C\u786C\u6821\u9A8C" },
  { key: "route", label: "\u901A\u9053\u8DEF\u7531" },
  { key: "execute", label: "\u6267\u884C\u9A8C\u8BC1" },
  { key: "case", label: "\u6848\u4F8B\u6C89\u6DC0" }
];
var snapshot = { progress: null, caseCount: 0, cases: [], loaded: false };
var snapshotListeners = /* @__PURE__ */ new Set();
var pollTimer = null;
var pollRefs = 0;
var POLL_INTERVAL_MS = 2e3;
function publish(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of snapshotListeners) {
    try {
      listener();
    } catch {
    }
  }
}
function sessionQuery() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("session");
    const fromGlobal = window.__DSH_SESSION_ID__;
    const id = fromUrl ?? fromGlobal;
    return typeof id === "string" && id !== "" ? `?session=${encodeURIComponent(id)}` : "";
  } catch {
    return "";
  }
}
async function refreshSnapshot() {
  try {
    const res = await fetch(`/api/autoflow/state${sessionQuery()}`, { cache: "no-store" });
    if (!res.ok) return;
    const body = await res.json();
    if (body?.ok !== true) return;
    publish({
      progress: body.progress ?? null,
      caseCount: body.caseCount ?? 0,
      cases: Array.isArray(body.cases) ? body.cases : [],
      loaded: true
    });
  } catch {
  }
}
function useSnapshot() {
  const [state, setState] = (0, import_react.useState)(snapshot);
  (0, import_react.useEffect)(() => {
    const sync = () => setState(snapshot);
    snapshotListeners.add(sync);
    sync();
    pollRefs += 1;
    if (pollTimer === null) {
      void refreshSnapshot();
      pollTimer = setInterval(() => {
        void refreshSnapshot();
      }, POLL_INTERVAL_MS);
    }
    return () => {
      snapshotListeners.delete(sync);
      pollRefs -= 1;
      if (pollRefs <= 0 && pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, []);
  return state;
}
var dockBus = { open: false, tab: "steps", listeners: /* @__PURE__ */ new Set() };
function setDock(patch) {
  dockBus = Object.assign({}, dockBus, patch);
  dockBus.listeners.forEach((fn) => {
    try {
      fn();
    } catch {
    }
  });
}
function toggleDock() {
  setDock({ open: !dockBus.open });
}
function useDock() {
  const [st, setSt] = (0, import_react.useState)(dockBus);
  (0, import_react.useEffect)(() => {
    const sync = () => setSt({ ...dockBus });
    dockBus.listeners.add(sync);
    return () => {
      dockBus.listeners.delete(sync);
    };
  }, []);
  return st;
}
var DOCK_GEOM_KEY = "dsh-dev-autoflow-dock-geom-v1";
function clampDockGeom(g) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.min(Math.max(380, Number(g.w) || 620), Math.max(380, vw - 16));
  const h = Math.min(Math.max(240, Number(g.h) || 520), Math.max(240, vh - 16));
  const x = Math.min(Math.max(8, Number(g.x) || 8), Math.max(8, vw - w - 8));
  const y = Math.min(Math.max(8, Number(g.y) || 8), Math.max(8, vh - Math.min(h, vh - 16) - 8));
  return { x, y, w, h };
}
function defaultDockGeom() {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.min(620, Math.max(380, vw - 16));
  const y = 48;
  const h = Math.max(240, Math.min(640, vh - y - 172));
  return { x: Math.max(8, vw - w - 8), y, w, h };
}
function loadDockGeom() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DOCK_GEOM_KEY) || "null");
    if (raw && typeof raw === "object") return clampDockGeom(raw);
  } catch {
  }
  return clampDockGeom(defaultDockGeom());
}
function saveDockGeom(g) {
  try {
    window.localStorage.setItem(DOCK_GEOM_KEY, JSON.stringify(clampDockGeom(g)));
  } catch {
  }
}
function applyDelta(origin, mode, dx, dy) {
  switch (mode) {
    case "move":
      return { x: origin.x + dx, y: origin.y + dy, w: origin.w, h: origin.h };
    case "left":
      return { x: origin.x + dx, y: origin.y, w: origin.w - dx, h: origin.h };
    case "right":
      return { x: origin.x, y: origin.y, w: origin.w + dx, h: origin.h };
    case "bottom":
      return { x: origin.x, y: origin.y, w: origin.w, h: origin.h + dy };
    case "corner":
      return { x: origin.x, y: origin.y, w: origin.w + dx, h: origin.h + dy };
  }
}
var DAF_CSS = `
.daf-dock{position:fixed;z-index:10050;display:flex;flex-direction:column;box-sizing:border-box;min-width:380px;min-height:240px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1c1c) 52%,transparent);backdrop-filter:blur(22px) saturate(1.35);-webkit-backdrop-filter:blur(22px) saturate(1.35);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#555) 65%,transparent);border-radius:12px;box-shadow:0 18px 48px color-mix(in srgb,#000 30%,transparent),0 0 0 1px color-mix(in srgb,#fff 6%,transparent);pointer-events:auto;color:var(--dsw-alias-label-primary,#f2f2f2);overflow:visible}
.daf-dock-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#555) 55%,transparent);background:transparent;cursor:grab;user-select:none;touch-action:none;color:var(--dsw-alias-label-primary,#f2f2f2);border-radius:12px 12px 0 0}
.daf-dock-head:active{cursor:grabbing}
.daf-dock-head b{font-size:14px;font-weight:600;color:inherit;text-shadow:0 1px 0 color-mix(in srgb,#000 18%,transparent)}
.daf-dock-head button{appearance:none;border:1px solid var(--dsw-alias-border-l1,#444);background:transparent;color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.daf-dock-head button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#6dbf8c);outline-offset:2px}
.daf-dock-head .daf-dock-tab-btn{border:none;background:transparent;padding:4px 8px;border-radius:6px;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#999)}
.daf-dock-head .daf-dock-tab-btn.on{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 22%,transparent);color:var(--dsw-alias-label-primary,#f2f2f2)}
.daf-dock-body{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;background:transparent;border-radius:0 0 12px 12px}
.daf-dock-body .daf-root{max-width:none;height:100%;flex:1;min-height:0;overflow:auto;background:transparent;padding:12px}
.daf-dock-resize,.daf-dock-resize-l,.daf-dock-resize-r,.daf-dock-resize-b{position:absolute;z-index:60;pointer-events:auto;touch-action:none}
.daf-dock-resize{right:-4px;bottom:-4px;width:18px;height:18px;cursor:nwse-resize;background:radial-gradient(circle at 100% 100%,color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 60%,transparent) 0 6px,transparent 7px)}
.daf-dock-resize-l{left:-2px;top:0;bottom:0;width:10px;cursor:ew-resize;background:transparent}
.daf-dock-resize-r{right:-2px;top:0;bottom:22px;width:10px;cursor:ew-resize;background:transparent}
.daf-dock-resize-b{left:10px;right:22px;bottom:-2px;height:10px;cursor:ns-resize;background:transparent}
.daf-title{font-size:15px;font-weight:650;margin-bottom:4px}
.daf-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#999);margin-bottom:12px}
.daf-steps{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}
.daf-step{padding:4px 10px;border-radius:12px;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#3a3f45) 55%,transparent);color:var(--dsw-alias-label-tertiary,#999);border:1px solid transparent}
.daf-step.active{background:var(--dsw-alias-brand-primary,#6dbf8c);color:#fff;font-weight:600}
.daf-step.done{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 26%,transparent);color:var(--dsw-alias-label-primary,#f2f2f2)}
.daf-step.fail{background:color-mix(in srgb,#e5534b 30%,transparent);color:#ffc1bc}
.daf-step.skipped{background:transparent;border-color:color-mix(in srgb,var(--dsw-alias-border-l1,#555) 70%,transparent);color:var(--dsw-alias-label-tertiary,#888);font-style:italic}
.daf-note{font-size:11px;color:var(--dsw-alias-label-secondary,#999);margin:-6px 0 12px;line-height:1.6}
.daf-card{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#555) 50%,transparent);border-radius:8px;padding:10px 12px;margin-top:12px;font-size:13px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1c1c) 55%,transparent)}
.daf-card h4{margin:0 0 6px;font-size:13px;font-weight:650}
.daf-list{margin:4px 0 0;padding-left:18px;font-size:12px}
.daf-list li{margin:4px 0}
.daf-muted{color:var(--dsw-alias-label-secondary,#999);font-size:12px}
.daf-tag{display:inline-block;padding:1px 6px;border-radius:6px;font-size:11px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#3a3f45) 60%,transparent);color:var(--dsw-alias-label-secondary,#bbb);margin-right:4px}
.daf-empty{color:var(--dsw-alias-label-tertiary,#777);font-size:12px;padding:18px 0;text-align:center}
`;
function DevAutoflowSteps() {
  const state = useSnapshot();
  const progress = state.progress;
  const steps = FALLBACK_STEPS.map((fallback) => {
    const live = progress?.steps.find((item) => item.key === fallback.key);
    return live ?? { ...fallback, status: "pending", note: "", updatedAt: 0 };
  });
  const notes = steps.filter((step) => step.note !== "");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-title", children: "\u81EA\u52A8\u6D41 \xB7 \u6267\u884C\u6B65\u9AA4" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-sub", children: [
      "\u5728\u804A\u5929\u6846\u76F4\u63A5\u63CF\u8FF0\u5F00\u53D1\u9700\u6C42\uFF08\u81EA\u52A8\u6D41\u6A21\u5F0F\uFF09\xB7 \u5DF2\u6C89\u6DC0\u6848\u4F8B ",
      state.caseCount,
      " \u6761",
      progress?.active === true ? " \xB7 \u6B63\u5728\u6267\u884C\u2026" : ""
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-steps", role: "list", "aria-label": "\u6D41\u6C34\u7EBF\u6B65\u9AA4\u72B6\u6001", children: steps.map((step) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "span",
      {
        role: "listitem",
        className: `daf-step ${step.status}`,
        "aria-label": `${step.label}\uFF1A${STATUS_TEXT[step.status]}${step.note ? `\uFF0C${step.note}` : ""}`,
        title: `${step.label}\uFF1A${STATUS_TEXT[step.status]}${step.note ? `
${step.note}` : ""}`,
        children: step.label
      },
      step.key
    )) }),
    notes.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-note", children: notes.map((step) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      step.label,
      "\uFF1A",
      step.note
    ] }, step.key)) }),
    state.cases.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: "\u6700\u8FD1\u6848\u4F8B" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "daf-list", children: state.cases.slice(-3).map((record) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "daf-tag", children: record.channel || "\u2014" }),
        record.summary,
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "daf-muted", children: [
          " \xB7 ",
          record.date,
          " \xB7 ",
          record.result
        ] })
      ] }, record.id)) })
    ] })
  ] });
}
function DevAutoflowCases() {
  const state = useSnapshot();
  const cases = state.cases;
  if (cases.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-root", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-title", children: "\u6848\u4F8B\u5E93" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-empty", children: state.loaded ? "\u6682\u65E0\u6848\u4F8B\u2014\u2014\u5728\u81EA\u52A8\u6D41\u6A21\u5F0F\u4E0B\u5B8C\u6210\u7B2C\u4E00\u4E2A\u5F00\u53D1\u4EFB\u52A1\u540E\uFF0C\u6848\u4F8B\u4F1A\u81EA\u52A8\u6C89\u6DC0\u5230\u8FD9\u91CC\u3002" : "\u6B63\u5728\u8BFB\u53D6\u6848\u4F8B\u5E93\u2026" })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-title", children: "\u6848\u4F8B\u5E93" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-sub", children: [
      "\u5171 ",
      cases.length,
      " \u6761 \xB7 \u8D8A\u7528\u8D8A\u51C6\uFF0C\u4F9B\u540E\u7EED\u4EFB\u52A1\u590D\u7528"
    ] }),
    [...cases].reverse().map((record) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h4", { children: [
        "#",
        record.id,
        " ",
        record.summary
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-muted", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "daf-tag", children: record.channel || "\u2014" }),
        record.deliverable || "\u2014",
        " \xB7 ",
        record.date
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-muted", style: { marginTop: 4 }, children: [
        "\u7ED3\u679C\uFF1A",
        record.result
      ] }),
      record.lesson && record.lesson !== "\u65E0" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-muted", style: { marginTop: 4 }, children: [
        "\u6559\u8BAD\uFF1A",
        record.lesson
      ] }) : null
    ] }, record.id))
  ] });
}
function DevAutoflowDock() {
  const st = useDock();
  const [geom, setGeom] = (0, import_react.useState)(() => loadDockGeom());
  const dragCleanup = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    const existing = document.querySelector('style[data-dsh-dev-autoflow-ui="1"]');
    if (!existing) {
      const styleTag = document.createElement("style");
      styleTag.setAttribute("data-dsh-dev-autoflow-ui", "1");
      styleTag.textContent = DAF_CSS;
      document.head.append(styleTag);
    }
  }, []);
  (0, import_react.useEffect)(() => {
    saveDockGeom(geom);
  }, [geom]);
  (0, import_react.useEffect)(() => {
    const onResize = () => setGeom((current) => clampDockGeom(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  (0, import_react.useEffect)(() => {
    if (!st.open) return void 0;
    const onKey = (event) => {
      if (event.key === "Escape") setDock({ open: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [st.open]);
  (0, import_react.useEffect)(() => () => dragCleanup.current?.(), []);
  if (!st.open) return null;
  const beginPointer = (event, mode) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (mode === "move" && typeof target.closest === "function" && target.closest("button,a,input,select,textarea,label")) {
      return;
    }
    event.preventDefault();
    dragCleanup.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = geom;
    const onMove = (ev) => {
      setGeom(clampDockGeom(applyDelta(origin, mode, ev.clientX - startX, ev.clientY - startY)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      dragCleanup.current = null;
    };
    dragCleanup.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  const panel = /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      className: "daf-dock",
      "data-open": st.open ? "1" : "0",
      role: "dialog",
      "aria-label": "\u81EA\u52A8\u6D41\u6267\u884C\u7A97\u53E3",
      style: { left: geom.x + "px", top: geom.y + "px", right: "auto", bottom: "auto", width: geom.w + "px", height: geom.h + "px" },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "daf-dock-head", onPointerDown: (event) => beginPointer(event, "move"), title: "\u6309\u4F4F\u62D6\u52A8\u7A97\u53E3", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "\u81EA\u52A8\u6D41" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: `daf-dock-tab-btn ${st.tab === "steps" ? "on" : ""}`,
              "aria-pressed": st.tab === "steps",
              onClick: () => setDock({ tab: "steps" }),
              children: "\u6267\u884C\u6B65\u9AA4"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: `daf-dock-tab-btn ${st.tab === "cases" ? "on" : ""}`,
              "aria-pressed": st.tab === "cases",
              onClick: () => setDock({ tab: "cases" }),
              children: "\u6848\u4F8B\u5E93"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => setDock({ open: false }), title: "\u6536\u8D77\u7A97\u53E3\uFF08Esc\uFF09", children: "\u6536\u8D77" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-dock-body", children: st.tab === "steps" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DevAutoflowSteps, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DevAutoflowCases, {}) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-dock-resize-l", title: "\u62D6\u52A8\u8C03\u6574\u5BBD\u5EA6", onPointerDown: (event) => beginPointer(event, "left") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-dock-resize-r", title: "\u62D6\u52A8\u8C03\u6574\u5BBD\u5EA6", onPointerDown: (event) => beginPointer(event, "right") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-dock-resize-b", title: "\u62D6\u52A8\u8C03\u6574\u9AD8\u5EA6", onPointerDown: (event) => beginPointer(event, "bottom") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "daf-dock-resize", title: "\u62D6\u52A8\u8C03\u6574\u5927\u5C0F", onPointerDown: (event) => beginPointer(event, "corner") })
      ]
    }
  );
  let portal = panel;
  try {
    const rd = require("react-dom");
    if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined" && document.body) {
      portal = rd.createPortal(panel, document.body);
    }
  } catch {
  }
  return portal;
}
function AutoflowLauncher() {
  const st = useDock();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      onClick: toggleDock,
      "aria-expanded": st.open,
      "aria-label": st.open ? "\u81EA\u52A8\u6D41\uFF1A\u6536\u8D77\u6267\u884C\u6B65\u9AA4\u7A97\u53E3" : "\u81EA\u52A8\u6D41\uFF1A\u6253\u5F00\u6267\u884C\u6B65\u9AA4\u7A97\u53E3",
      title: st.open ? "\u81EA\u52A8\u6D41\uFF1A\u6536\u8D77\u6267\u884C\u6B65\u9AA4\u7A97\u53E3" : "\u81EA\u52A8\u6D41\uFF1A\u6253\u5F00\u6267\u884C\u6B65\u9AA4\u7A97\u53E3",
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
        height: 28,
        padding: "0 10px",
        margin: "0 2px",
        border: "none",
        borderRadius: 8,
        background: st.open ? "var(--dsw-alias-brand-primary, #4f8cff)" : "transparent",
        color: st.open ? "var(--dsw-alias-bg-base, #fff)" : "var(--dsw-alias-label-secondary, #8a94a6)",
        cursor: "pointer",
        fontSize: 12.5,
        fontWeight: 500
      },
      children: "\u81EA\u52A8\u6D41"
    }
  );
}
function apply(ctx) {
  const slots = ctx.slots;
  if (slots === void 0) {
    console.warn("[dsh-dev-autoflow] slots service unavailable; skipping UI registration");
    return;
  }
  ctx.effect?.(
    () => slots.inject(
      "conversation.input.right",
      () => slots.register(
        {
          name: "conversation.input.right",
          id: "dev-autoflow-launcher",
          order: 45,
          label: "dev-autoflow"
        },
        AutoflowLauncher
      )
    ),
    "dsh-dev-autoflow: composer launcher"
  );
  ctx.effect?.(
    () => slots.inject(
      "shell.overlay",
      () => slots.register(
        {
          name: "shell.overlay",
          id: "dev-autoflow-dock",
          order: 50
        },
        DevAutoflowDock
      )
    ),
    "dsh-dev-autoflow: dock overlay"
  );
}
return module.exports; } });
