import { api, requireData } from '@/shared/api';
import { ambulancePageSchema, ambulanceSchema, tripPageSchema, tripSchema } from './schemas';
import type {
  Ambulance,
  AmbulanceKind,
  AmbulancePage,
  AmbulanceStatus,
  AmbulanceTrip,
  AmbulanceTripPage,
  TripStatus,
} from './types';

export async function fetchAmbulances(
  { status, cursor, limit }: { status?: AmbulanceStatus; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<AmbulancePage> {
  const result = await api.GET('/ambulances', {
    params: { query: { status, cursor, limit } },
    signal,
  });
  return ambulancePageSchema.parse(requireData(result));
}

export async function createAmbulance(
  body: { registration: string; kind: AmbulanceKind },
  key: string,
): Promise<Ambulance> {
  const result = await api.POST('/ambulances', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return ambulanceSchema.parse(requireData(result));
}

/** Out of service and back, from an available ambulance only. */
export async function setService(
  { ambulance, to }: { ambulance: Ambulance; to: 'available' | 'out_of_service' },
  key: string,
): Promise<Ambulance> {
  const result = await api.POST('/ambulances/{ambulanceId}/service', {
    params: { path: { ambulanceId: ambulance.id }, header: { 'idempotency-key': key } },
    body: { status: to, version: ambulance.version },
  });
  return ambulanceSchema.parse(requireData(result));
}

export async function fetchTrips(
  { status, cursor, limit }: { status?: TripStatus; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<AmbulanceTripPage> {
  const result = await api.GET('/ambulance-trips', {
    params: { query: { status, cursor, limit } },
    signal,
  });
  return tripPageSchema.parse(requireData(result));
}

export async function requestTrip(
  body: { patientId?: string; pickup: string; destination: string },
  key: string,
): Promise<AmbulanceTrip> {
  const result = await api.POST('/ambulance-trips', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return tripSchema.parse(requireData(result));
}

export interface TripMove {
  trip: AmbulanceTrip;
  to: 'dispatched' | 'picked_up' | 'completed' | 'cancelled';
  /** Required to dispatch. */
  ambulanceId?: string;
}

export async function moveTrip(move: TripMove, key: string): Promise<AmbulanceTrip> {
  const result = await api.POST('/ambulance-trips/{tripId}/move', {
    params: { path: { tripId: move.trip.id }, header: { 'idempotency-key': key } },
    body: {
      to: move.to,
      version: move.trip.version,
      ...(move.ambulanceId ? { ambulanceId: move.ambulanceId } : {}),
    },
  });
  return tripSchema.parse(requireData(result));
}
