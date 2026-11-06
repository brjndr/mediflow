import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import {
  createHospital,
  fetchAdminInvites,
  fetchHospital,
  fetchHospitals,
  inviteHospitalAdmin,
  revokeAdminInvite,
  setHospitalFeatures,
  updateHospital,
} from '../api';
import type { Hospital, HospitalCreate, HospitalLimitsUpdate, HospitalStatus } from '../types';

/**
 * Keys of the platform's own data. They carry no hospital id because a platform admin has none:
 * what is cached is the list of hospitals, which belongs to the platform. Every way a session
 * ends drops the whole cache, so nothing outlives the person who read it.
 */
export const platformKeys = {
  all: ['platform'] as const,
  hospitals: () => [...platformKeys.all, 'hospitals'] as const,
  hospital: (id: string) => [...platformKeys.hospitals(), 'detail', id] as const,
  invites: (id: string) => [...platformKeys.hospital(id), 'invites'] as const,
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

export function useHospital(id: string) {
  return useQuery({
    queryKey: platformKeys.hospital(id),
    queryFn: ({ signal }) => fetchHospital(id, signal),
  });
}

/** After a change the saved hospital replaces the cached one, and the list is read again. */
function useSavedHospital() {
  const queryClient = useQueryClient();
  return (saved: Hospital) => {
    queryClient.setQueryData(platformKeys.hospital(saved.id), saved);
    return queryClient.invalidateQueries({
      queryKey: [...platformKeys.hospitals(), 'list'],
    });
  };
}

export function useSetHospitalFeatures(id: string) {
  const saved = useSavedHospital();
  return useMutation({
    mutationFn: (features: { feature: string; enabled: boolean }[]) =>
      setHospitalFeatures(id, features),
    onSuccess: saved,
  });
}

export function useUpdateHospitalLimits(id: string) {
  const saved = useSavedHospital();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: HospitalLimitsUpdate) => updateHospital(id, body),
    onSuccess: saved,
    // Someone saved first: read the hospital again so the newest version is known.
    onError: () => queryClient.invalidateQueries({ queryKey: platformKeys.hospital(id) }),
  });
}

export function useAdminInvites(hospitalId: string) {
  return useQuery({
    queryKey: platformKeys.invites(hospitalId),
    queryFn: ({ signal }) => fetchAdminInvites(hospitalId, signal),
  });
}

/** Inviting (and inviting the same address again) changes the open invites, so they are read again. */
export function useInviteAdmin(hospitalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; email: string }) => inviteHospitalAdmin(hospitalId, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformKeys.invites(hospitalId) }),
  });
}

export function useRevokeInvite(hospitalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => revokeAdminInvite(hospitalId, inviteId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformKeys.invites(hospitalId) }),
  });
}
