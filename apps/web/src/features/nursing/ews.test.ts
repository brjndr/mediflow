import { describe, expect, it } from 'vitest';
import { DEFAULT_EWS_CONFIG, isWorsening, scoreReading } from './ews';

describe('the early warning score', () => {
  it('scores a normal reading as 0 and normal', () => {
    expect(scoreReading({ systolic: 120, pulse: 72, temperature: 37, spo2: 98 })).toEqual({
      score: 0,
      level: 'normal',
      measured: 4,
    });
  });

  it('adds the points of each measurement', () => {
    // 2 (systolic 95) + 2 (pulse 120) + 1 (temperature 38.5) + 3 (spo2 90) = 8
    expect(scoreReading({ systolic: 95, pulse: 120, temperature: 38.5, spo2: 90 })).toMatchObject({
      score: 8,
      level: 'urgent',
    });
  });

  it('asks for attention at the threshold or for one measurement alone', () => {
    expect(scoreReading({ spo2: 90 })).toMatchObject({ score: 3, level: 'attention' });
    expect(scoreReading({ systolic: 105, pulse: 95, temperature: 38.5, spo2: 95 })).toMatchObject({
      score: 4,
      level: 'normal',
    });
  });

  it('is null without a scored measurement and follows a changed config', () => {
    expect(scoreReading({})).toBeNull();
    const strict = { ...DEFAULT_EWS_CONFIG, attention: 1 };
    expect(scoreReading({ pulse: 95 }, strict)?.level).toBe('attention');
  });

  it('sees scores getting worse', () => {
    expect(isWorsening([1])).toBe(false);
    expect(isWorsening([1, 3])).toBe(true);
    expect(isWorsening([1, 2, 3])).toBe(true);
    expect(isWorsening([3, 2, 2])).toBe(false);
  });
});
