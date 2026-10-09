import { QueryClient } from '@tanstack/react-query';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000, // CLAUDE.md Performance Strategy: 5 minute gcTime
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}
