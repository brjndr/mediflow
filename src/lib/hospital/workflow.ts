// Patient care workflow: a small state machine shared by the server (which
// enforces it) and the UI (which renders allowed next steps and why a step is
// blocked). Pure module — no server or React imports.
import type { PatientStatus } from './schemas'

export const STAGES = [
  'REGISTERED',
  'TRIAGE',
  'ADMITTED',
  'TREATMENT',
  'READY_FOR_DISCHARGE',
  'DISCHARGED',
] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABEL: Record<Stage, string> = {
  REGISTERED: 'Registered',
  TRIAGE: 'Triage',
  ADMITTED: 'Admitted',
  TREATMENT: 'Under treatment',
  READY_FOR_DISCHARGE: 'Ready for discharge',
  DISCHARGED: 'Discharged',
}

export const TRANSITIONS: Record<Stage, ReadonlyArray<Stage>> = {
  REGISTERED: ['TRIAGE'],
  TRIAGE: ['ADMITTED', 'DISCHARGED'], // admit, or treat-and-release
  ADMITTED: ['TREATMENT'],
  TREATMENT: ['READY_FOR_DISCHARGE'],
  READY_FOR_DISCHARGE: ['TREATMENT', 'DISCHARGED'], // relapse or discharge
  DISCHARGED: [],
}

export interface TransitionContext {
  vitalsCount: number
  hasDischargeSummary: boolean
}

export type TransitionCheck = { ok: true } | { ok: false; reason: string }

/** Rules: legal edge + clinical guards. */
export function checkTransition(
  from: Stage,
  to: Stage,
  ctx: TransitionContext,
): TransitionCheck {
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      reason: `Cannot move from ${STAGE_LABEL[from]} to ${STAGE_LABEL[to]}`,
    }
  }
  if (from === 'TRIAGE' && ctx.vitalsCount === 0) {
    return { ok: false, reason: 'Record triage vitals before leaving triage' }
  }
  if (to === 'DISCHARGED' && !ctx.hasDischargeSummary) {
    return { ok: false, reason: 'Add a discharge summary note first' }
  }
  return { ok: true }
}

/** Keep the coarse patient status consistent with the stage. */
export function statusAfter(current: PatientStatus, to: Stage): PatientStatus {
  if (to === 'DISCHARGED') return 'DISCHARGED'
  if ((to === 'ADMITTED' || to === 'TREATMENT') && current === 'OUTPATIENT') {
    return 'ADMITTED'
  }
  return current
}

export interface StageEvent {
  id: string
  patientId: string
  from: Stage | null
  to: Stage
  at: string
  by: string
  note?: string
}
