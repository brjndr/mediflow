/** Non-secret runtime config from VITE_ variables (CLAUDE.md Frontend implications). */
export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
  /** Where error reports go. A DSN is not a secret. Unset means no error reporting at all. */
  sentryDsn: import.meta.env.VITE_SENTRY_DSN || undefined,
} as const;
