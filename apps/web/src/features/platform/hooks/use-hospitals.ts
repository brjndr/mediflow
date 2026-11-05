import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createHospital, fetchHospitals } from '../api';
import type { HospitalCreate, HospitalStatus } from '../types';

/**
 * Keys of the platform's own data. They carry no hospital id because a platform admin has none:
 * what is cached is the list of hospitals, which belongs to the platform. Every way a session
 * ends drops the whole cache, so nothing outlives the person who read it.
 */
export const platformKeys = {
  all: ['platform'] as const,
  hospitals: () => [...platformKeys.all, 'hospitals'] as const,
  hospitalList: (filters: unknown) => [...platformKeys.hospitals(), 'list', filters] as const,
};

export const HOSPITALS_PAGE_SIZE = 25;

export function useHospitals({ status, q }: { status?: HospitalStatus; q?: string }) {
  return useInfiniteQuery({
    queryKey: platformKeys.hospitalList({ status, q, limit: HOSPITALS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchHospitals({ cursor: pageParam, limit: HOSPITALS_PAGE_SIZE, status, q }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** Creates a hospital, then asks for the list again so it shows there. */
export function useCreateHospital() {
  const queryClient = useQueryClient();
  // One key for one request as typed: sending the same again reuses it, an edited one gets a new key.
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    mutationFn: (body: HospitalCreate) => {
      const text = JSON.stringify(body);
      if (attempt.current?.body !== text) {
        attempt.current = { body: text, key: crypto.randomUUID() };
      }
      return createHospital(body, attempt.current.key);
    },
    onSuccess: () => {
      // Done: the next hospital, even with the same values, is a new request.
      attempt.current = undefined;
      return queryClient.invalidateQueries({ queryKey: platformKeys.hospitals() });
    },
  });
}
