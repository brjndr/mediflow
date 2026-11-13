import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  Ambulance,
  AmbulanceKind,
  AmbulancePage,
  AmbulanceStatus,
  AmbulanceTrip,
  AmbulanceTripPage,
  CrewMember,
  CrewRole,
  TripStatus,
} from './types';

export const PAGE_SIZE = 50;
export const KINDS = ['basic', 'advanced', 'neonatal'] as const satisfies readonly AmbulanceKind[];
export const AMBULANCE_STATUSES = [
  'available',
  'on_trip',
  'out_of_service',
] as const satisfies readonly AmbulanceStatus[];
export const TRIP_STATUSES = [
  'requested',
  'dispatched',
  'picked_up',
  'completed',
  'cancelled',
] as const satisfies readonly TripStatus[];

export const CREW_ROLES = [
  'driver',
  'paramedic',
  'attendant',
] as const satisfies readonly CrewRole[];
/** The most people a dispatch may name (the server's limit). */
export const MAX_CREW = 8;

/** The moves a person may make from a status, as the server's table allows them. */
export function allowedTripMoves(status: TripStatus) {
  return {
    dispatch: status === 'requested',
    pickUp: status === 'dispatched',
    complete: status === 'picked_up',
    cancel: status === 'requested' || status === 'dispatched',
  };
}

const place = z
  .string()
  .trim()
  .min(1, 'validation.required')
  .max(300, 'validation.invalid_value')
  .regex(PLAIN_TEXT, 'validation.plain_text');

export const tripFormSchema = z.object({
  pickup: place,
  destination: place,
  /** A visit of the chosen patient the trip is charged to; empty for no charge. */
  encounterId: z.string(),
});
export type TripFormValues = z.infer<typeof tripFormSchema>;

export const ambulanceFormSchema = z.object({
  registration: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(30, 'validation.invalid_value')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  kind: z.enum(KINDS),
});
export type AmbulanceFormValues = z.infer<typeof ambulanceFormSchema>;

export const ambulanceSchema: z.ZodType<Ambulance> = z.object({
  id: z.string(),
  tenantId: z.string(),
  registration: z.string(),
  kind: z.enum(KINDS),
  status: z.enum(AMBULANCE_STATUSES),
  version: z.number().int().min(1),
});
export const ambulancePageSchema: z.ZodType<AmbulancePage> = z.object({
  items: z.array(ambulanceSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const crewMemberSchema: z.ZodType<CrewMember> = z.object({
  userId: z.string(),
  userName: z.string(),
  duty: z.enum(CREW_ROLES),
});

export const tripSchema: z.ZodType<AmbulanceTrip> = z.object({
  id: z.string(),
  tenantId: z.string(),
  patientId: z.string().optional(),
  encounterId: z.string().optional(),
  serviceId: z.string().optional(),
  serviceName: z.string().optional(),
  ambulanceId: z.string().optional(),
  ambulanceRegistration: z.string().optional(),
  pickup: z.string(),
  destination: z.string(),
  status: z.enum(TRIP_STATUSES),
  requestedAt: z.string(),
  dispatchedAt: z.string().optional(),
  pickedUpAt: z.string().optional(),
  finishedAt: z.string().optional(),
  crew: z.array(crewMemberSchema),
  version: z.number().int().min(1),
});
export const tripPageSchema: z.ZodType<AmbulanceTripPage> = z.object({
  items: z.array(tripSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});
