/**
 * The log-side check of the audit seals (#1092), for as long as there are no write-once copies:
 * each `audit_sealed` line carries the seal and the one it follows, and two different seals after
 * the same one mean a tail of a chain was removed and sealed again. It reads the logs (kept off
 * the database), never the database, so removing rows there cannot hide it.
 */
export interface ForkedSeal {
  tenantId: string;
  prevSeal: string | null;
  seals: string[];
}

export function forkedSeals(lines: Iterable<string>): ForkedSeal[] {
  const followers = new Map<
    string,
    { tenantId: string; prevSeal: string | null; seals: Set<string> }
  >();
  for (const line of lines) {
    if (!line.includes('audit_sealed')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const { event, tenantId, seal, prevSeal } = entry as Record<string, unknown>;
    if (event !== 'audit_sealed' || typeof tenantId !== 'string' || typeof seal !== 'string') {
      continue;
    }
    const prev = typeof prevSeal === 'string' ? prevSeal : null;
    const key = `${tenantId}/${prev ?? ''}`;
    const found = followers.get(key) ?? { tenantId, prevSeal: prev, seals: new Set<string>() };
    found.seals.add(seal);
    followers.set(key, found);
  }
  return [...followers.values()]
    .filter((found) => found.seals.size > 1)
    .map((found) => ({
      tenantId: found.tenantId,
      prevSeal: found.prevSeal,
      seals: [...found.seals],
    }));
}
