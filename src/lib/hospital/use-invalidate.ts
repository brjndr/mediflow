import { useQueryClient } from '@tanstack/react-query'

import { hospitalKeys } from './queries'

/** Refresh everything derived from patient data after a write. */
export function useInvalidatePatientData() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: hospitalKeys.patients }),
      queryClient.invalidateQueries({ queryKey: hospitalKeys.stats }),
      queryClient.invalidateQueries({ queryKey: ['db', 'patients'] }),
    ])
}
