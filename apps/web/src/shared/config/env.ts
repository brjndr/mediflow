/** Non-secret runtime config from VITE_ variables (CLAUDE.md Frontend implications). */
export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
} as const;
