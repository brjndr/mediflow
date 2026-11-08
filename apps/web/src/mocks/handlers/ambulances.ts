import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type Ambulance = components['schemas']['Ambulance'];
type Trip = components['schemas']['AmbulanceTrip'];
type TripStatus = Trip['status'];

const FEATURE_FLAG = 'ambulance';

const MOVES: Record<TripStatus, TripStatus[]> = {
  requested: ['dispatched', 'cancelled'],
  dispatched: ['picked_up', 'cancelled'],
  picked_up: ['completed'],
  completed: [],
  cancelled: [],
};

const seedFleet = (): Ambulance[] => [
  {
    id: 'amb_1',
    tenantId: TENANT_IDS.hospital,
    registration: 'KA01AB1234',
    kind: 'advanced',
    status: 'available',
    version: 1,
  },
  {
    id: 'amb_2',
    tenantId: TENANT_IDS.hospital,
    registration: 'KA01CD5678',
    kind: 'basic',
    status: 'available',
    version: 1,
  },
];
const seedTrips = (): Trip[] => [
  {
    id: 'trip_1',
    tenantId: TENANT_IDS.hospital,
    pickup: 'Main Road junction',
    destination: 'Emergency entrance',
    status: 'requested',
    requestedAt: '2026-11-07T09:00:00.000Z',
    version: 1,
  },
];

let fleet = seedFleet();
let trips = seedTrips();
let created = 0;
const replies = new Map<string, string>();
onMockReset(() => {
  fleet = seedFleet();
  trips = seedTrips();
  created = 0;
  replies.clear();
});

function page<T extends { id: string }>(all: T[], query: URLSearchParams) {
  const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
  const cursor = query.get('cursor');
  const start = cursor ? all.findIndex((row) => row.id === cursor) : 0;
  if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
  const next = all[start + limit];
  return HttpResponse.json({
    items: all.slice(start, start + limit),
    nextCursor: next ? next.id : null,
    ...(cursor ? {} : { total: all.length }),
  });
}

const withKey = (request: Request) => request.headers.get('Idempotency-Key');

export const ambulanceHandlers = [
  http.get('*/api/ambulances', ({ request }) => {
    const access = authorize(request, { permission: 'ambulance:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const status = query.get('status');
    return page(
      fleet.filter((a) => a.tenantId === access.tenantId && (!status || a.status === status)),
      query,
    );
  }),

  http.post('*/api/ambulances', async ({ request }) => {
    const access = authorize(request, {
      permission: 'ambulance:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = withKey(request);
    if (!key) return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const body = (await request.json().catch(() => null)) as {
      registration?: unknown;
      kind?: unknown;
    } | null;
    if (
      typeof body?.registration !== 'string' ||
      body.registration.trim() === '' ||
      (body.kind !== 'basic' && body.kind !== 'advanced' && body.kind !== 'neonatal')
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const registration = body.registration.trim().toUpperCase();
    const replyKey = `${access.tenantId}:${key}`;
    const known = replies.get(replyKey);
    const existing = known ? fleet.find((a) => a.id === known) : undefined;
    if (existing) return HttpResponse.json(existing, { status: 201 });
    if (fleet.some((a) => a.tenantId === access.tenantId && a.registration === registration)) {
      return error(409, 'duplicate_registration', 'That registration exists');
    }
    created += 1;
    const made: Ambulance = {
      id: `amb_new_${created}`,
      tenantId: access.tenantId,
      registration,
      kind: body.kind,
      status: 'available',
      version: 1,
    };
    fleet.push(made);
    replies.set(replyKey, made.id);
    return HttpResponse.json(made, { status: 201 });
  }),

  http.post('*/api/ambulances/:ambulanceId/service', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'ambulance:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      status?: unknown;
      version?: unknown;
    } | null;
    if (
      (body?.status !== 'available' && body?.status !== 'out_of_service') ||
      typeof body.version !== 'number'
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const row = fleet.find((a) => a.id === params.ambulanceId && a.tenantId === access.tenantId);
    if (!row) return error(404, 'ambulance_not_found', 'No such ambulance');
    if (row.version !== body.version) return error(409, 'conflict', 'It has changed');
    const from = body.status === 'out_of_service' ? 'available' : 'out_of_service';
    if (row.status !== from) return error(409, 'invalid_transition', 'Not from that status');
    Object.assign(row, { status: body.status, version: row.version + 1 });
    return HttpResponse.json(row);
  }),

  http.get('*/api/ambulance-trips', ({ request }) => {
    const access = authorize(request, { permission: 'ambulance:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const status = query.get('status');
    return page(
      trips.filter((x) => x.tenantId === access.tenantId && (!status || x.status === status)),
      query,
    );
  }),

  http.post('*/api/ambulance-trips', async ({ request }) => {
    const access = authorize(request, {
      permission: 'ambulance:dispatch',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = withKey(request);
    if (!key) return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    const body = (await request.json().catch(() => null)) as {
      patientId?: unknown;
      pickup?: unknown;
      destination?: unknown;
    } | null;
    if (typeof body?.pickup !== 'string' || typeof body.destination !== 'string') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const replyKey = `${access.tenantId}:${key}`;
    const known = replies.get(replyKey);
    const existing = known ? trips.find((x) => x.id === known) : undefined;
    if (existing) return HttpResponse.json(existing, { status: 201 });
    created += 1;
    const made: Trip = {
      id: `trip_new_${created}`,
      tenantId: access.tenantId,
      ...(typeof body.patientId === 'string' ? { patientId: body.patientId } : {}),
      pickup: body.pickup,
      destination: body.destination,
      status: 'requested',
      requestedAt: new Date().toISOString(),
      version: 1,
    };
    trips.push(made);
    replies.set(replyKey, made.id);
    return HttpResponse.json(made, { status: 201 });
  }),

  http.post('*/api/ambulance-trips/:tripId/move', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'ambulance:dispatch',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      to?: unknown;
      version?: unknown;
      ambulanceId?: unknown;
    } | null;
    const to = body?.to as TripStatus | undefined;
    if (!to || !(to in MOVES) || typeof body?.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const trip = trips.find((x) => x.id === params.tripId && x.tenantId === access.tenantId);
    if (!trip) return error(404, 'trip_not_found', 'No such trip');
    if (trip.version !== body.version) return error(409, 'conflict', 'It has changed');
    if (!MOVES[trip.status].includes(to)) {
      return error(409, 'invalid_transition', 'That move is not allowed');
    }
    const now = new Date().toISOString();
    if (to === 'dispatched') {
      if (typeof body.ambulanceId !== 'string') {
        return error(422, 'ambulance_required', 'Say which ambulance goes');
      }
      const ambulance = fleet.find(
        (a) => a.id === body.ambulanceId && a.tenantId === access.tenantId,
      );
      if (!ambulance) return error(422, 'unknown_ambulance', 'No such ambulance');
      if (ambulance.status !== 'available') {
        return error(409, 'ambulance_unavailable', 'The ambulance cannot go now');
      }
      Object.assign(ambulance, { status: 'on_trip', version: ambulance.version + 1 });
      Object.assign(trip, {
        ambulanceId: ambulance.id,
        ambulanceRegistration: ambulance.registration,
        dispatchedAt: now,
      });
    }
    if (to === 'picked_up') trip.pickedUpAt = now;
    if (to === 'completed' || to === 'cancelled') {
      trip.finishedAt = now;
      // Ending or cancelling the trip frees its ambulance.
      const ambulance = fleet.find((a) => a.id === trip.ambulanceId);
      if (ambulance?.status === 'on_trip') {
        Object.assign(ambulance, { status: 'available', version: ambulance.version + 1 });
      }
    }
    Object.assign(trip, { status: to, version: trip.version + 1 });
    return HttpResponse.json(trip);
  }),
];
