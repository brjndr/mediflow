/**
 * The early warning score: points for each measurement from the band it falls in, added up. A band
 * takes `min` (included) up to `max` (excluded); either may be left out. The defaults follow the
 * bands of the UK's NEWS2 for the four measurements the ward chart holds (blood pressure, pulse,
 * temperature and oxygen saturation). Respiratory rate, oxygen use and consciousness are not
 * recorded on the chart, so the score is a guide, not NEWS2 itself.
 */
export const EWS_MEASURES = ['systolic', 'pulse', 'temperature', 'spo2'] as const;
export type EwsMeasure = (typeof EWS_MEASURES)[number];

export interface EwsBand {
  min?: number;
  max?: number;
  points: number;
}

export interface EwsConfig {
  bands: Record<EwsMeasure, EwsBand[]>;
  /** A total at or above this asks for the nurse in charge to be told. */
  attention: number;
  /** A total at or above this asks for an urgent review by a doctor. */
  urgent: number;
  /** One measurement alone scoring this much also asks for attention. */
  singleMeasure: number;
}

export const DEFAULT_EWS_CONFIG: EwsConfig = {
  bands: {
    systolic: [
      { max: 91, points: 3 },
      { min: 91, max: 101, points: 2 },
      { min: 101, max: 111, points: 1 },
      { min: 111, max: 220, points: 0 },
      { min: 220, points: 3 },
    ],
    pulse: [
      { max: 41, points: 3 },
      { min: 41, max: 51, points: 1 },
      { min: 51, max: 91, points: 0 },
      { min: 91, max: 111, points: 1 },
      { min: 111, max: 131, points: 2 },
      { min: 131, points: 3 },
    ],
    temperature: [
      { max: 35.1, points: 3 },
      { min: 35.1, max: 36.1, points: 1 },
      { min: 36.1, max: 38.1, points: 0 },
      { min: 38.1, max: 39.1, points: 1 },
      { min: 39.1, points: 2 },
    ],
    spo2: [
      { max: 92, points: 3 },
      { min: 92, max: 94, points: 2 },
      { min: 94, max: 96, points: 1 },
      { min: 96, points: 0 },
    ],
  },
  attention: 5,
  urgent: 7,
  singleMeasure: 3,
};

export type EwsLevel = 'normal' | 'attention' | 'urgent';

export interface EwsResult {
  score: number;
  level: EwsLevel;
  /** How many of the measurements were part of the reading. */
  measured: number;
}

type Reading = Partial<Record<EwsMeasure, number>>;

function pointsFor(bands: EwsBand[], value: number): number {
  const band = bands.find(
    (each) =>
      (each.min === undefined || value >= each.min) && (each.max === undefined || value < each.max),
  );
  return band?.points ?? 0;
}

/** The score of one reading, or null when it holds none of the scored measurements. */
export function scoreReading(
  reading: Reading,
  config: EwsConfig = DEFAULT_EWS_CONFIG,
): EwsResult | null {
  let score = 0;
  let measured = 0;
  let highest = 0;
  for (const name of EWS_MEASURES) {
    const value = reading[name];
    if (value === undefined) continue;
    const points = pointsFor(config.bands[name], value);
    measured += 1;
    score += points;
    highest = Math.max(highest, points);
  }
  if (measured === 0) return null;
  const level: EwsLevel =
    score >= config.urgent
      ? 'urgent'
      : score >= config.attention || highest >= config.singleMeasure
        ? 'attention'
        : 'normal';
  return { score, level, measured };
}

/**
 * Whether the scores, oldest first, are getting worse: up by two or more since the reading
 * before, or up at each of the last three readings.
 */
export function isWorsening(scores: number[]): boolean {
  const n = scores.length;
  if (n < 2) return false;
  if (scores[n - 1]! - scores[n - 2]! >= 2) return true;
  return n >= 3 && scores[n - 1]! > scores[n - 2]! && scores[n - 2]! > scores[n - 3]!;
}
