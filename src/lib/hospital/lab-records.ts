export interface LabRecord {
  id: number
  patient: string
  test: string
  value: number
  unit: string
  low: number
  high: number
  abnormal: boolean
  at: number
}

const TESTS = [
  { test: 'Hemoglobin', unit: 'g/dL', low: 12, high: 17.5 },
  { test: 'WBC count', unit: '10^9/L', low: 4, high: 11 },
  { test: 'Glucose (fasting)', unit: 'mg/dL', low: 70, high: 100 },
  { test: 'Creatinine', unit: 'mg/dL', low: 0.6, high: 1.3 },
  { test: 'Potassium', unit: 'mmol/L', low: 3.5, high: 5.1 },
  { test: 'Sodium', unit: 'mmol/L', low: 135, high: 145 },
  { test: 'Troponin I', unit: 'ng/mL', low: 0, high: 0.04 },
  { test: 'CRP', unit: 'mg/L', low: 0, high: 10 },
]
const FIRST = [
  'Ava',
  'Liam',
  'Noah',
  'Mia',
  'Zoe',
  'Ethan',
  'Isla',
  'Omar',
  'Priya',
  'Kai',
]
const LAST = [
  'Nguyen',
  'Garcia',
  'Okafor',
  'Schmidt',
  'Rossi',
  'Khan',
  'Silva',
  'Ito',
  'Cohen',
  'Lopez',
]

// Small deterministic PRNG so server and client agree and no faker bundle
// is shipped to the browser for this 25k-row demo dataset.
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateLabRecords(
  count: number,
  now = Date.now(),
): Array<LabRecord> {
  const rand = mulberry32(42)
  return Array.from({ length: count }, (_, id) => {
    const t = TESTS[Math.floor(rand() * TESTS.length)]
    const span = t.high - t.low || 1
    // ~15% of results land outside the reference range
    const outlier = rand() < 0.15
    const value = outlier
      ? rand() < 0.5
        ? t.low - rand() * span * 0.5
        : t.high + rand() * span * 0.5
      : t.low + rand() * span
    const rounded = Math.round(Math.max(value, 0) * 100) / 100
    return {
      id,
      patient: `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`,
      test: t.test,
      value: rounded,
      unit: t.unit,
      low: t.low,
      high: t.high,
      abnormal: rounded < t.low || rounded > t.high,
      at: now - Math.floor(rand() * 30 * 24 * 3600 * 1000),
    }
  }).sort((a, b) => b.at - a.at)
}
