import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/react-query'

import {
  createAppointment,
  listAppointments,
  listDoctors,
  listPatients,
  updateAppointmentStatus,
} from '#/server/hospital.functions'

/**
 * TanStack DB collections backed by the server functions through the Query
 * adapter. Collections are client-only (no SSR), so they are created lazily
 * per QueryClient from a route with `ssr: false`.
 */
function buildCollections(queryClient: QueryClient) {
  const patients = createCollection(
    queryCollectionOptions({
      queryKey: ['db', 'patients'],
      queryFn: () => listPatients(),
      queryClient,
      getKey: (p) => p.id,
    }),
  )

  const doctors = createCollection(
    queryCollectionOptions({
      queryKey: ['db', 'doctors'],
      queryFn: () => listDoctors(),
      queryClient,
      getKey: (d) => d.id,
    }),
  )

  const appointments = createCollection(
    queryCollectionOptions({
      queryKey: ['db', 'appointments'],
      queryFn: () => listAppointments(),
      queryClient,
      getKey: (a) => a.id,
      // Optimistic insert/update: the UI changes instantly, the handler
      // persists, and the collection refetches to reconcile server ids.
      onInsert: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((m) => {
            const { patientId, doctorId, scheduledAt, reason } = m.modified
            return createAppointment({
              data: { patientId, doctorId, scheduledAt, reason },
            })
          }),
        )
      },
      onUpdate: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((m) =>
            updateAppointmentStatus({
              data: { id: String(m.key), status: m.modified.status },
            }),
          ),
        )
      },
    }),
  )

  return { patients, doctors, appointments }
}

const cache = new WeakMap<QueryClient, ReturnType<typeof buildCollections>>()

export function getCollections(queryClient: QueryClient) {
  let collections = cache.get(queryClient)
  if (!collections) {
    collections = buildCollections(queryClient)
    cache.set(queryClient, collections)
  }
  return collections
}
