// Shared (client + server safe) workflow constants. Do not import server modules here.
export const VISIT_STATUSES = [
  'scheduled',
  'checked_in',
  'triaged',
  'consulted',
  'paid',
  'discharged',
  'cancelled',
] as const
export type VisitStatus = (typeof VISIT_STATUSES)[number]

export const STATUS_LABEL: Record<VisitStatus, string> = {
  scheduled: 'Scheduled',
  checked_in: 'Checked in',
  triaged: 'Triaged',
  consulted: 'Consulted',
  paid: 'Paid',
  discharged: 'Discharged',
  cancelled: 'Cancelled',
}

/** Who acts next on a visit in each status (drives the dashboard "my queue"). */
export const NEXT_ACTOR: Partial<Record<VisitStatus, string>> = {
  scheduled: 'frontdesk',
  checked_in: 'nurse',
  triaged: 'doctor',
  consulted: 'billing',
  paid: 'frontdesk',
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
