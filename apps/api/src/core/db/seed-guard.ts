/**
 * Decides whether the development seed may run against a database.
 *
 * The seed creates sample hospitals, staff who all share one known password, and sample patients.
 * In a real environment that is a way in, so it only ever runs against a database on this
 * machine, or one whose host is named on the command line by whoever runs it.
 */

/** Hosts that are this machine: a native Postgres, or the Docker Compose service. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

export interface SeedDecision {
  allowed: boolean;
  /** Why not, for the person running the script. Never contains credentials. */
  reason?: string;
}

/**
 * `allowHost` is the value of `--allow-host=<hostname>`: a deliberate, exact opt-in for one
 * database, such as a staging one. There is no way to allow every host.
 */
export function seedDecision(
  databaseUrl: string,
  nodeEnv: string,
  allowHost?: string,
): SeedDecision {
  if (nodeEnv === 'production') {
    return { allowed: false, reason: 'Refusing to seed sample accounts in production.' };
  }
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return { allowed: false, reason: 'Refusing to seed: DATABASE_URL is not a valid address.' };
  }
  if (LOCAL_HOSTS.has(host)) return { allowed: true };
  if (allowHost !== undefined && allowHost !== '' && allowHost.toLowerCase() === host) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      `Refusing to seed sample accounts into a database on "${host}", which is not this machine. ` +
      `The sample staff share a known password. If this really is a throwaway database, run the ` +
      `seed again with --allow-host=${host}.`,
  };
}
