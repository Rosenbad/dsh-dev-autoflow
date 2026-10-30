export const name: string
export const inject: string[]
export interface Config {
  /** Path to scripts/spec_check.py. Relative paths resolve against the package root. */
  specScript?: string
  /** Path to the case library markdown. Defaults to `<data dir>/cases.md` (~/.dsh/autoflow). */
  caseFile?: string
}
export type StepStatus = "pending" | "active" | "done" | "fail" | "skipped"
export interface StepState {
  key: string
  label: string
  status: StepStatus
  note: string
  updatedAt: number
}
export function apply(ctx: unknown, config?: Config): void
export function resetProgress(sessionKey?: string): void
export function setStepState(sessionKey: string, key: string, status: StepStatus, note?: string): void
export function finishProgress(sessionKey: string, failed?: boolean): void
export function currentProgress(sessionKey?: string): { active: boolean; steps: StepState[] }
