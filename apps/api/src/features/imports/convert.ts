import type { TObject } from '@sinclair/typebox';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { ImportColumn } from '../../core/imports/registry.js';

/** What is wrong with a row: one field of it, or (no field) the whole row. */
export interface Problem {
  field?: string;
  code: string;
}

export type Converted = { body: Record<string, unknown> } | { problems: Problem[] };

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);
const WHOLE = /^\d{1,15}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Digits, grouped by commas in thousands (1,234,567) or the Indian way (12,34,567), or not. */
const AMOUNT = /^(\d+|\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})*,\d{3})(\.\d+)?$/;

const isCalendarDate = (text: string): boolean => {
  const parsed = new Date(`${text}T00:00:00Z`);
  return (
    ISO_DATE.test(text) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === text
  );
};

/**
 * An amount as minor units, on its digits and never through a floating-point number, or the code
 * of why the text is not one.
 */
export function toMinor(
  text: string,
  minorDigits: number,
): number | 'not_an_amount' | 'too_many_decimals' {
  if (!AMOUNT.test(text)) return 'not_an_amount';
  const [whole = '', fraction = ''] = text.replace(/,/g, '').split('.');
  if (fraction.length > minorDigits) return 'too_many_decimals';
  const minor =
    BigInt(whole) * 10n ** BigInt(minorDigits) + BigInt(fraction.padEnd(minorDigits, '0') || '0');
  // Beyond what a schema allows for an amount anyway: it refuses it.
  return minor > BigInt(Number.MAX_SAFE_INTEGER) ? 'not_an_amount' : Number(minor);
}

/** The value of one field, or the code of what is wrong with its text. */
function valueOf(
  column: ImportColumn,
  text: string,
  minorDigits: number,
): { value: unknown } | { code: string } {
  switch (column.type) {
    case 'text':
      return { value: text };
    case 'integer':
      return WHOLE.test(text) ? { value: Number(text) } : { code: 'not_a_whole_number' };
    case 'boolean': {
      const word = text.toLowerCase();
      if (YES.has(word)) return { value: true };
      if (NO.has(word)) return { value: false };
      return { code: 'not_yes_or_no' };
    }
    case 'enum': {
      const word = text.toLowerCase();
      return column.values.includes(word) ? { value: word } : { code: 'not_allowed' };
    }
    case 'date':
      return isCalendarDate(text) ? { value: text } : { code: 'not_a_date' };
    case 'amount': {
      const minor = toMinor(text, minorDigits);
      return typeof minor === 'number' ? { value: minor } : { code: minor };
    }
  }
}

// One validator for every kind, with the formats the routes' own validator knows.
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
addFormats.default(ajv);
const compiled = new WeakMap<TObject, ValidateFunction>();

function validatorFor(schema: TObject): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

/**
 * A row's text, field by field, made into the body its kind's create route takes, and checked
 * against that route's schema. Text is trimmed and empty text is no value. A problem names the
 * field and a code, never the text.
 */
export function convert(
  columns: readonly ImportColumn[],
  body: TObject,
  values: Record<string, string>,
  minorDigits: number,
): Converted {
  const out: Record<string, unknown> = {};
  const problems: Problem[] = [];
  for (const column of columns) {
    const text = (values[column.field] ?? '').trim();
    if (text === '') {
      if (column.required) problems.push({ field: column.field, code: 'required' });
      continue;
    }
    const result = valueOf(column, text, minorDigits);
    if ('code' in result) problems.push({ field: column.field, code: result.code });
    else out[column.field] = result.value;
  }
  if (problems.length > 0) return { problems };

  const validate = validatorFor(body);
  if (validate(out)) return { body: out };
  const seen = new Set<string>();
  for (const error of validate.errors ?? []) {
    const field =
      error.instancePath.split('/')[1] ??
      (typeof error.params.missingProperty === 'string' ? error.params.missingProperty : undefined);
    const key = field ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(field ? { field, code: 'invalid' } : { code: 'invalid' });
  }
  return { problems: problems.length > 0 ? problems : [{ code: 'invalid' }] };
}

/** The digits after the point in an amount of the currency: 2 for INR, 0 for JPY, 3 for KWD. */
export function minorDigitsOf(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}
