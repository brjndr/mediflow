import { Badge } from '#/components/ui/badge'
import { STAGE_LABEL } from '#/lib/hospital/workflow'
import type { Stage } from '#/lib/hospital/workflow'

const tone = {
  REGISTERED: 'neutral',
  TRIAGE: 'warning',
  ADMITTED: 'info',
  TREATMENT: 'info',
  READY_FOR_DISCHARGE: 'success',
  DISCHARGED: 'neutral',
} as const

export default function StageBadge({ stage }: { stage: Stage }) {
  return <Badge tone={tone[stage]}>{STAGE_LABEL[stage]}</Badge>
}
