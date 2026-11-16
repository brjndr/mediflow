import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import { fetchAdmissionSettings, saveAdmissionSettings } from '../api';
import { admissionKeys } from './use-admissions';

const settingsKey = (tenantId: string) => [...admissionKeys.all(tenantId), 'settings'] as const;

/** The hospital's admission settings. Needs `admission:configure`; `enabled` is false without it. */
export function useAdmissionSettings(enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: settingsKey(tenantId ?? ''),
    queryFn: ({ signal }) => fetchAdmissionSettings(signal),
    enabled: enabled && tenantId !== undefined,
    retry: false,
  });
}

export function useSaveAdmissionSettings() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    mutationFn: saveAdmissionSettings,
    onSuccess: (saved) => {
      if (tenantId) queryClient.setQueryData(settingsKey(tenantId), saved);
    },
  });
}
