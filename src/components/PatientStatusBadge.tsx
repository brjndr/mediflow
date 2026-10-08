import { Badge } from '#/components/ui/badge'
import { patientStatusTone } from '#/lib/hospital/schemas'
import type { PatientStatus } from '#/lib/hospital/schemas'

export default function PatientStatusBadge({
  status,
}: {
  status: PatientStatus
}) {
  return <Badge tone={patientStatusTone[status]}>{status}</Badge>
}
