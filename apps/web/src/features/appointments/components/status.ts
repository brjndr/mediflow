import type { AppointmentStatus } from '../types';

/** How each status is drawn as a badge, on the list and on the appointment. */
export const STATUS_STYLE: Record<AppointmentStatus, string> = {
  scheduled: 'bg-primary/10 text-primary',
  completed: 'bg-muted text-foreground',
  cancelled: 'bg-muted text-muted-foreground line-through',
  no_show: 'bg-destructive/10 text-destructive',
};
