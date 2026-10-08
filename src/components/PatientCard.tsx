import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { Badge } from '#/components/ui/badge'
import { patientQuery } from '#/lib/hospital/queries'
import { fullName, patientStatusTone } from '#/lib/hospital/schemas'

export default function PatientCard({ id }: { id: string }) {
  const { data: patient, isPending } = useQuery(patientQuery(id))

  if (isPending) {
    return <div className="demo-muted p-3 text-sm">Loading patient…</div>
  }
  if (!patient) {
    return <div className="demo-muted p-3 text-sm">Patient not found.</div>
  }

  return (
    <div className="my-2 rounded-xl border border-[var(--line)] bg-[var(--chip-bg)] p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <strong>{fullName(patient)}</strong>
        <Badge tone={patientStatusTone[patient.status]}>{patient.status}</Badge>
      </div>
      <p className="m-0 mt-1 text-[var(--sea-ink-soft)]">
        {patient.mrn} · {patient.ward} · {patient.condition}
      </p>
      <Link
        to="/patients/$patientId"
        params={{ patientId: patient.id }}
        className="mt-2 inline-block font-semibold text-[var(--lagoon-deep)]"
      >
        Open chart →
      </Link>
    </div>
  )
}
