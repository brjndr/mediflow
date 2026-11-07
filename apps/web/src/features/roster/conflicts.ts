import { MIN_REST_HOURS } from './schemas';
import type { RosterShift } from './types';

/** The ways a person's duty can be wrong in the shifts shown. */
export type ConflictKind = 'overlap' | 'rest';

/**
 * What is wrong with a person's duty in the shifts given: an overlap (the server refuses it, but
 * a roster may hold one from before) or less than `MIN_REST_HOURS` between two shifts. Every
 * shift involved is flagged, by id. Cancelled shifts count for nothing.
 */
export function rosterConflicts(shifts: RosterShift[]): Map<string, ConflictKind> {
  const flagged = new Map<string, ConflictKind>();
  const byPerson = new Map<string, RosterShift[]>();
  for (const shift of shifts) {
    if (shift.status !== 'scheduled') continue;
    byPerson.set(shift.userId, [...(byPerson.get(shift.userId) ?? []), shift]);
  }
  for (const own of byPerson.values()) {
    own.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    for (let i = 1; i < own.length; i += 1) {
      const before = own[i - 1] as RosterShift;
      const after = own[i] as RosterShift;
      const gapHours = (Date.parse(after.startsAt) - Date.parse(before.endsAt)) / 3_600_000;
      const kind: ConflictKind | undefined =
        gapHours < 0 ? 'overlap' : gapHours < MIN_REST_HOURS ? 'rest' : undefined;
      if (!kind) continue;
      for (const one of [before, after]) {
        if (flagged.get(one.id) !== 'overlap') flagged.set(one.id, kind);
      }
    }
  }
  return flagged;
}
