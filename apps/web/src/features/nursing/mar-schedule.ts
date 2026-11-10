import { zonedToUtc } from '@/shared/utils';
import type { MarEntry, MarOrder } from './types';

/**
 * The doses a medication order is due, worked out from its frequency (#158). The API keeps no
 * schedule: an entry names the order and the time the dose was due, and a second entry for the
 * same order and time is refused. So every device must work out the same instants: clock times in
 * the hospital's timezone, from the table below, the same for every hospital.
 */

const WORDS: Record<string, string[]> = {
  od: ['08:00'],
  qd: ['08:00'],
  daily: ['08:00'],
  hs: ['22:00'],
  bd: ['08:00', '20:00'],
  bid: ['08:00', '20:00'],
  bds: ['08:00', '20:00'],
  tds: ['06:00', '14:00', '22:00'],
  tid: ['06:00', '14:00', '22:00'],
  qid: ['06:00', '12:00', '18:00', '22:00'],
  qds: ['06:00', '12:00', '18:00', '22:00'],
};

/** "1-0-1" by the number of parts: morning, noon, evening, night as the parts go. */
const PARTS: Record<number, string[]> = {
  2: ['08:00', '20:00'],
  3: ['08:00', '14:00', '21:00'],
  4: ['06:00', '12:00', '18:00', '22:00'],
};

const pad = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/**
 * The clock times a day a frequency is due, or null when it sets none ("as needed", "SOS", or
 * anything not understood): such an order is charted as it is given.
 */
export function slotTimes(frequency: string): string[] | null {
  const text = frequency.trim().toLowerCase();
  if (/^\d(-\d){1,3}$/.test(text)) {
    const counts = text.split('-').map(Number);
    const times = PARTS[counts.length];
    if (!times) return null;
    const due = times.filter((_, index) => (counts[index] ?? 0) > 0);
    return due.length > 0 ? due : null;
  }
  const every = /^q(\d{1,2})h$/.exec(text);
  if (every?.[1]) {
    const hours = Number(every[1]);
    if (hours < 1 || hours > 24) return null;
    const count = Math.max(1, Math.floor(24 / hours));
    return Array.from({ length: count }, (_, index) => pad((6 + index * hours) % 24)).sort();
  }
  return WORDS[text] ?? null;
}

export interface DoseSlot {
  order: MarOrder;
  /** When it is due, an ISO instant. */
  scheduledAt: string;
}

/** The slots of the orders on a hospital day, none before the order was placed. */
export function slotsOn(orders: MarOrder[], day: string, timezone: string): DoseSlot[] {
  return orders
    .flatMap((order) =>
      (slotTimes(order.frequency) ?? []).map((time) => ({
        order,
        scheduledAt: zonedToUtc(day, time, timezone),
      })),
    )
    .filter((slot) => slot.scheduledAt >= slot.order.placedAt.slice(0, 16));
}

/** The entry that stands for a slot: not one that was corrected. */
export function standingEntry(
  entries: MarEntry[],
  orderId: string,
  scheduledAt: string,
): MarEntry | undefined {
  const due = new Date(scheduledAt).getTime();
  return entries.find(
    (entry) =>
      entry.orderId === orderId &&
      new Date(entry.scheduledAt).getTime() === due &&
      entry.correctedById === undefined,
  );
}

export type SlotState = 'recorded' | 'due' | 'overdue' | 'later';

/** An hour past its time a dose is overdue; before the hour before it, it is for later. */
export function slotState(scheduledAt: string, recorded: boolean, now: Date): SlotState {
  if (recorded) return 'recorded';
  const due = new Date(scheduledAt).getTime();
  const at = now.getTime();
  if (at > due + 60 * 60_000) return 'overdue';
  if (at < due - 60 * 60_000) return 'later';
  return 'due';
}
