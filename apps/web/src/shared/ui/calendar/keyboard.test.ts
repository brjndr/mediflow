import { describe, expect, it } from 'vitest';
import {
  clockTime,
  move,
  partOn,
  resolve,
  type GridEvent,
  type Stop,
  type StopsByDay,
} from './keyboard';

const stop = (day: string, minutes: number, eventId?: string): Stop => ({
  day,
  minutes,
  element: document.createElement('div'),
  ...(eventId === undefined ? {} : { eventId }),
});

/** Two days: a block at nine on the first, free times at eight and half past nine. */
function twoDays(): StopsByDay {
  return new Map([
    [
      '2026-10-15',
      [stop('2026-10-15', 480), stop('2026-10-15', 540, 'a'), stop('2026-10-15', 570)],
    ],
    ['2026-10-16', [stop('2026-10-16', 480), stop('2026-10-16', 600)]],
  ]);
}

describe('resolve', () => {
  it('finds the block, or the last stop at or before the time', () => {
    const stops = twoDays();
    expect(resolve(stops, { day: '2026-10-15', minutes: 0, eventId: 'a' })?.eventId).toBe('a');
    expect(resolve(stops, { day: '2026-10-15', minutes: 560 })?.eventId).toBe('a');
    expect(resolve(stops, { day: '2026-10-16', minutes: 590 })?.minutes).toBe(480);
    // Before the first stop: the first.
    expect(resolve(stops, { day: '2026-10-16', minutes: 0 })?.minutes).toBe(480);
    expect(resolve(stops, { day: '2026-10-17', minutes: 0 })).toBeUndefined();
  });
});

describe('move', () => {
  const at = { day: '2026-10-15', minutes: 540, eventId: 'a' };

  it('goes up and down within a day, and stops at its ends', () => {
    const stops = twoDays();
    expect(move('ArrowDown', at, stops, 7)?.cursor).toEqual({ day: '2026-10-15', minutes: 570 });
    expect(move('ArrowUp', at, stops, 7)?.cursor).toEqual({ day: '2026-10-15', minutes: 480 });
    const last = { day: '2026-10-15', minutes: 570 };
    expect(move('ArrowDown', last, stops, 7)?.cursor).toEqual(last);
    expect(move('Home', at, stops, 7)?.cursor.minutes).toBe(480);
    expect(move('End', at, stops, 7)?.cursor.minutes).toBe(570);
  });

  it('goes to the same time on a neighbouring day, and says when it is not drawn', () => {
    const stops = twoDays();
    expect(move('ArrowRight', at, stops, 7)).toEqual({
      cursor: { day: '2026-10-16', minutes: 540 },
      outside: false,
    });
    expect(move('ArrowLeft', at, stops, 7)?.outside).toBe(true);
    expect(move('PageDown', at, stops, 7)).toEqual({
      cursor: { day: '2026-10-22', minutes: 540 },
      outside: true,
    });
    expect(move('PageUp', at, stops, 1)?.cursor.day).toBe('2026-10-14');
    expect(move('a', at, stops, 7)).toBeUndefined();
  });
});

describe('partOn', () => {
  const night: GridEvent = {
    startDay: '2026-10-15',
    start: 1410,
    endDay: '2026-10-16',
    end: 30,
    name: '',
  };

  it('gives the part of a block on each of its days', () => {
    expect(partOn(night, '2026-10-15')).toEqual([1410, 1440]);
    expect(partOn(night, '2026-10-16')).toEqual([0, 30]);
    expect(partOn(night, '2026-10-17')).toBeUndefined();
  });

  it('gives a block of no length a minute, so it is still a stop', () => {
    const instant = { ...night, endDay: '2026-10-15', end: 1410 };
    expect(partOn(instant, '2026-10-15')).toEqual([1410, 1411]);
  });
});

it('writes minutes as a clock time', () => {
  expect(clockTime(0)).toBe('00:00');
  expect(clockTime(11 * 60 + 15)).toBe('11:15');
});
