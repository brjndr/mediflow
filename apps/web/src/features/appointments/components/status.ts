import type { StatusTone } from '@/shared/ui/status-badge';
import type { AppointmentStatus } from '../types';

/** The tone each status is drawn in, as a `StatusBadge`, on the list and on the appointment. */
export const STATUS_TONE: Record<AppointmentStatus, StatusTone> = {
  scheduled: 'info',
  completed: 'success',
  cancelled: 'neutral',
  no_show: 'danger',
};
