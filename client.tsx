/**
 * dsh-dev-autoflow — client half.
 *
 * Renders a floating, draggable, resizable execution window that mirrors the
 * dsh-purge dock pattern: a position:fixed panel portaled onto document.body,
 * dragged by its title bar, resized by four handles, closed via 收起 or Esc.
 *
 * Data comes from one aggregated endpoint (`/api/autoflow/state`) polled by a
 * single shared timer — one request per tick no matter how many components
 * subscribe, and no polling at all while the window is closed.
 *
 * Contract: the build script wraps this file in
 * window.__ModuleLoader__.load({ id, factory }) — do NOT call it here.
 * react is externalized and provided by the app's module system through the
 * factory's require parameter.
 */
import { useEffect, useRef, useState } from 'react'

export const inject = ['slots']

/* ---------------- types (mirror host) ---------------- */

type StepStatus = 'pending' | 'active' | 'done' | 'fail' | 'skipped'

interface CaseRecord {
  id: number
  date: string
  summary: string
  channel: string
  deliverable: string
  result: string
  lesson: string
}

interface StepState {
  key: string
  label: string
  status: StepStatus
  note: string
  updatedAt: number
}

interface Progress {
  active: boolean
  steps: StepState[]
}

interface StateResponse {
  ok?: boolean
  progress?: Progress
  caseCount?: number
  cases?: CaseRecord[]
}

const STATUS_TEXT: Record<StepStatus, string> = {
  pending: '待执行',
  active: '执行中',
  done: '完成',
  fail: '失败',
  skipped: '已跳过',
}

const FALLBACK_STEPS: { key: string; label: string }[] = [
  { key: 'spec', label: '需求重构' },
  { key: 'check', label: '规格硬校验' },
  { key: 'route', label: '通道路由' },
  { key: 'execute', label: '执行验证' },
  { key: 'case', label: '案例沉淀' },
]

/* ---------------- shared state (one poller for the whole window) ---------------- */

interface Snapshot {
  progress: Progress | null
  caseCount: number
  cases: CaseRecord[]
  loaded: boolean
}

let snapshot: Snapshot = { progress: null, caseCount: 0, cases: [], loaded: false }
const snapshotListeners = new Set<() => void>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollRefs = 0
const POLL_INTERVAL_MS = 2000

function publish(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of snapshotListeners) {
    try {
      listener()
    } catch {
      /* a broken subscriber must not stop the others */
    }
  }
}

/** Session id, when the shell exposes one (keeps windows from crossing over). */
function sessionQuery(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('session')
    const fromGlobal = (window as unknown as { __DSH_SESSION_ID__?: string }).__DSH_SESSION_ID__
    const id = fromUrl ?? fromGlobal
    return typeof id === 'string' && id !== '' ? `?session=${encodeURIComponent(id)}` : ''
  } catch {
    return ''
  }
}

async function refreshSnapshot(): Promise<void> {
  try {
    const res = await fetch(`/api/autoflow/state${sessionQuery()}`, { cache: 'no-store' })
    if (!res.ok) return
    const body = (await res.json()) as StateResponse
    if (body?.ok !== true) return
    publish({
      progress: body.progress ?? null,
      caseCount: body.caseCount ?? 0,
      cases: Array.isArray(body.cases) ? body.cases : [],
      loaded: true,
    })
  } catch {
    /* host restarting / endpoint not ready yet — keep the last snapshot */
  }
}

function useSnapshot(): Snapshot {
  const [state, setState] = useState(snapshot)
  useEffect(() => {
    const sync = (): void => setState(snapshot)
    snapshotListeners.add(sync)
    sync()
    pollRefs += 1
    if (pollTimer === null) {
      void refreshSnapshot()
      pollTimer = setInterval(() => {
        void refreshSnapshot()
      }, POLL_INTERVAL_MS)
    }
    return () => {
      snapshotListeners.delete(sync)
      pollRefs -= 1
      if (pollRefs <= 0 && pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  }, [])
  return state
}

/* ---------------- dock state (module-level bus, mirrors dsh-purge) ---------------- */

interface DockState {
  open: boolean
  tab: 'steps' | 'cases'
  listeners: Set<() => void>
}

let dockBus: DockState = { open: false, tab: 'steps', listeners: new Set() }

function setDock(patch: Partial<DockState>): void {
  dockBus = Object.assign({}, dockBus, patch)
  dockBus.listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  })
}

function toggleDock(): void {
  setDock({ open: !dockBus.open })
}

function useDock(): DockState {
  const [st, setSt] = useState(dockBus)
  useEffect(() => {
    const sync = (): void => setSt({ ...dockBus })
    dockBus.listeners.add(sync)
    return () => {
      dockBus.listeners.delete(sync)
    }
  }, [])
  return st
}

/* ---------------- dock geometry (draggable/resizable, persisted) ---------------- */

const DOCK_GEOM_KEY = 'dsh-dev-autoflow-dock-geom-v1'

interface DockGeom {
  x: number
  y: number
  w: number
  h: number
}

type ResizeMode = 'move' | 'left' | 'right' | 'bottom' | 'corner'

function clampDockGeom(g: DockGeom): DockGeom {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const w = Math.min(Math.max(380, Number(g.w) || 620), Math.max(380, vw - 16))
  const h = Math.min(Math.max(240, Number(g.h) || 520), Math.max(240, vh - 16))
  const x = Math.min(Math.max(8, Number(g.x) || 8), Math.max(8, vw - w - 8))
  const y = Math.min(Math.max(8, Number(g.y) || 8), Math.max(8, vh - Math.min(h, vh - 16) - 8))
  return { x, y, w, h }
}

function defaultDockGeom(): DockGeom {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const w = Math.min(620, Math.max(380, vw - 16))
  const y = 48
  const h = Math.max(240, Math.min(640, vh - y - 172))
  return { x: Math.max(8, vw - w - 8), y, w, h }
}

function loadDockGeom(): DockGeom {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DOCK_GEOM_KEY) || 'null')
    if (raw && typeof raw === 'object') return clampDockGeom(raw as DockGeom)
  } catch {
    /* ignore */
  }
  return clampDockGeom(defaultDockGeom())
}

function saveDockGeom(g: DockGeom): void {
  try {
    window.localStorage.setItem(DOCK_GEOM_KEY, JSON.stringify(clampDockGeom(g)))
  } catch {
    /* ignore */
  }
}

function applyDelta(origin: DockGeom, mode: ResizeMode, dx: number, dy: number): DockGeom {
  switch (mode) {
    case 'move':
      return { x: origin.x + dx, y: origin.y + dy, w: origin.w, h: origin.h }
    case 'left':
      return { x: origin.x + dx, y: origin.y, w: origin.w - dx, h: origin.h }
    case 'right':
      return { x: origin.x, y: origin.y, w: origin.w + dx, h: origin.h }
    case 'bottom':
      return { x: origin.x, y: origin.y, w: origin.w, h: origin.h + dy }
    case 'corner':
      return { x: origin.x, y: origin.y, w: origin.w + dx, h: origin.h + dy }
  }
}

/* ---------------- css (dynamic inject, host theme tokens) ---------------- */

const DAF_CSS = `
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
`

/* ---------------- window content ---------------- */

function DevAutoflowSteps(): JSX.Element {
  const state = useSnapshot()
  const progress = state.progress
  const steps: StepState[] = FALLBACK_STEPS.map((fallback) => {
    const live = progress?.steps.find((item) => item.key === fallback.key)
    return live ?? { ...fallback, status: 'pending' as StepStatus, note: '', updatedAt: 0 }
  })
  const notes = steps.filter((step) => step.note !== '')

  return (
    <div className="daf-root">
      <div className="daf-title">自动流 · 执行步骤</div>
      <div className="daf-sub">
        在聊天框直接描述开发需求（自动流模式）· 已沉淀案例 {state.caseCount} 条
        {progress?.active === true ? ' · 正在执行…' : ''}
      </div>

      <div className="daf-steps" role="list" aria-label="流水线步骤状态">
        {steps.map((step) => (
          <span
            key={step.key}
            role="listitem"
            className={`daf-step ${step.status}`}
            aria-label={`${step.label}：${STATUS_TEXT[step.status]}${step.note ? `，${step.note}` : ''}`}
            title={`${step.label}：${STATUS_TEXT[step.status]}${step.note ? `\n${step.note}` : ''}`}
          >
            {step.label}
          </span>
        ))}
      </div>

      {notes.length > 0 && (
        <div className="daf-note">
          {notes.map((step) => (
            <div key={step.key}>
              {step.label}：{step.note}
            </div>
          ))}
        </div>
      )}

      {state.cases.length > 0 && (
        <div className="daf-card">
          <h4>最近案例</h4>
          <ul className="daf-list">
            {state.cases.slice(-3).map((record) => (
              <li key={record.id}>
                <span className="daf-tag">{record.channel || '—'}</span>
                {record.summary}
                <span className="daf-muted"> · {record.date} · {record.result}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function DevAutoflowCases(): JSX.Element {
  const state = useSnapshot()
  const cases = state.cases

  if (cases.length === 0) {
    return (
      <div className="daf-root">
        <div className="daf-title">案例库</div>
        <div className="daf-empty">
          {state.loaded ? '暂无案例——在自动流模式下完成第一个开发任务后，案例会自动沉淀到这里。' : '正在读取案例库…'}
        </div>
      </div>
    )
  }

  return (
    <div className="daf-root">
      <div className="daf-title">案例库</div>
      <div className="daf-sub">共 {cases.length} 条 · 越用越准，供后续任务复用</div>
      {[...cases].reverse().map((record) => (
        <div className="daf-card" key={record.id}>
          <h4>
            #{record.id} {record.summary}
          </h4>
          <div className="daf-muted">
            <span className="daf-tag">{record.channel || '—'}</span>
            {record.deliverable || '—'} · {record.date}
          </div>
          <div className="daf-muted" style={{ marginTop: 4 }}>
            结果：{record.result}
          </div>
          {record.lesson && record.lesson !== '无' ? (
            <div className="daf-muted" style={{ marginTop: 4 }}>
              教训：{record.lesson}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/* ---------------- floating dock (mirrors dsh-purge) ---------------- */

function DevAutoflowDock(): JSX.Element | null {
  const st = useDock()
  const [geom, setGeom] = useState<DockGeom>(() => loadDockGeom())
  const dragCleanup = useRef<(() => void) | null>(null)

  // Inject css once.
  useEffect(() => {
    const existing = document.querySelector('style[data-dsh-dev-autoflow-ui="1"]') as HTMLStyleElement | null
    if (!existing) {
      const styleTag = document.createElement('style')
      styleTag.setAttribute('data-dsh-dev-autoflow-ui', '1')
      styleTag.textContent = DAF_CSS
      document.head.append(styleTag)
    }
  }, [])

  // Persist geometry + clamp on window resize.
  useEffect(() => {
    saveDockGeom(geom)
  }, [geom])
  useEffect(() => {
    const onResize = (): void => setGeom((current) => clampDockGeom(current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Esc closes the window; never leave a pointer listener behind on unmount.
  useEffect(() => {
    if (!st.open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDock({ open: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [st.open])
  useEffect(() => () => dragCleanup.current?.(), [])

  if (!st.open) return null

  const beginPointer = (event: React.PointerEvent, mode: ResizeMode): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (mode === 'move' && typeof target.closest === 'function' && target.closest('button,a,input,select,textarea,label')) {
      return
    }
    event.preventDefault()
    dragCleanup.current?.()
    const startX = event.clientX
    const startY = event.clientY
    const origin = geom
    const onMove = (ev: PointerEvent): void => {
      setGeom(clampDockGeom(applyDelta(origin, mode, ev.clientX - startX, ev.clientY - startY)))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      dragCleanup.current = null
    }
    dragCleanup.current = stop
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const panel = (
    <div
      className="daf-dock"
      data-open={st.open ? '1' : '0'}
      role="dialog"
      aria-label="自动流执行窗口"
      style={{ left: geom.x + 'px', top: geom.y + 'px', right: 'auto', bottom: 'auto', width: geom.w + 'px', height: geom.h + 'px' }}
    >
      <div className="daf-dock-head" onPointerDown={(event) => beginPointer(event, 'move')} title="按住拖动窗口">
        <b>自动流</b>
        <button
          type="button"
          className={`daf-dock-tab-btn ${st.tab === 'steps' ? 'on' : ''}`}
          aria-pressed={st.tab === 'steps'}
          onClick={() => setDock({ tab: 'steps' })}
        >
          执行步骤
        </button>
        <button
          type="button"
          className={`daf-dock-tab-btn ${st.tab === 'cases' ? 'on' : ''}`}
          aria-pressed={st.tab === 'cases'}
          onClick={() => setDock({ tab: 'cases' })}
        >
          案例库
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setDock({ open: false })} title="收起窗口（Esc）">
          收起
        </button>
      </div>
      <div className="daf-dock-body">{st.tab === 'steps' ? <DevAutoflowSteps /> : <DevAutoflowCases />}</div>
      <div className="daf-dock-resize-l" title="拖动调整宽度" onPointerDown={(event) => beginPointer(event, 'left')} />
      <div className="daf-dock-resize-r" title="拖动调整宽度" onPointerDown={(event) => beginPointer(event, 'right')} />
      <div className="daf-dock-resize-b" title="拖动调整高度" onPointerDown={(event) => beginPointer(event, 'bottom')} />
      <div className="daf-dock-resize" title="拖动调整大小" onPointerDown={(event) => beginPointer(event, 'corner')} />
    </div>
  )

  // Portal onto document.body so the window floats above everything.
  let portal: JSX.Element | React.ReactPortal = panel
  try {
    const rd = require('react-dom') as { createPortal?: (node: React.ReactNode, target: Element) => React.ReactPortal }
    if (rd && typeof rd.createPortal === 'function' && typeof document !== 'undefined' && document.body) {
      portal = rd.createPortal(panel, document.body)
    }
  } catch {
    /* host may not expose react-dom; fall back to rendering inline */
  }
  return portal
}

/* ---------------- launcher (conversation.input.right) ---------------- */

function AutoflowLauncher(): JSX.Element {
  const st = useDock()
  return (
    <button
      type="button"
      onClick={toggleDock}
      aria-expanded={st.open}
      aria-label={st.open ? '自动流：收起执行步骤窗口' : '自动流：打开执行步骤窗口'}
      title={st.open ? '自动流：收起执行步骤窗口' : '自动流：打开执行步骤窗口'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        height: 28,
        padding: '0 10px',
        margin: '0 2px',
        border: 'none',
        borderRadius: 8,
        background: st.open ? 'var(--dsw-alias-brand-primary, #4f8cff)' : 'transparent',
        color: st.open ? 'var(--dsw-alias-bg-base, #fff)' : 'var(--dsw-alias-label-secondary, #8a94a6)',
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 500,
      }}
    >
      自动流
    </button>
  )
}

/* ---------------- slots mounting ---------------- */

interface SlotRegistry {
  inject(key: string, callback: () => unknown): () => void
  register(opts: Record<string, unknown>, component: unknown): unknown
}
interface ClientContext {
  slots?: SlotRegistry
  effect?(callback: () => unknown, label?: string): unknown
}

export function apply(ctx: ClientContext): void {
  const slots = ctx.slots
  if (slots === undefined) {
    console.warn('[dsh-dev-autoflow] slots service unavailable; skipping UI registration')
    return
  }
  ctx.effect?.(
    () =>
      slots.inject('conversation.input.right', () =>
        slots.register(
          {
            name: 'conversation.input.right',
            id: 'dev-autoflow-launcher',
            order: 45,
            label: 'dev-autoflow',
          },
          AutoflowLauncher,
        ),
      ),
    'dsh-dev-autoflow: composer launcher',
  )
  ctx.effect?.(
    () =>
      slots.inject('shell.overlay', () =>
        slots.register(
          {
            name: 'shell.overlay',
            id: 'dev-autoflow-dock',
            order: 50,
          },
          DevAutoflowDock,
        ),
      ),
    'dsh-dev-autoflow: dock overlay',
  )
}
