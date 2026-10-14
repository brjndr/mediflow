import { HttpError } from '../../core/http/errors.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import type { ImportKind, Writer } from '../../core/imports/registry.js';
import {
  drugExists,
  hasControlledSibling,
  insertDrug,
  isDrugExists,
  type DrugDetails,
  type DrugRow,
} from './repository.js';
import {
  DRUG_FORMS,
  DRUG_SCHEDULES,
  DRUG_TYPES,
  DrugCreate,
  NAME_MAX,
  SHORT_MAX,
  TAX_CLASSES,
} from './schemas.js';

export const exists = () => new HttpError(409, 'drug_exists', 'The hospital has exactly this item');

/** A name as it is stored, and not empty once it is tidied. */
export function cleanName(name: string): string {
  const tidied = tidyWithin(name, NAME_MAX);
  if (tidied === '') throw new HttpError(400, 'validation_failed', 'A generic name is required');
  return tidied;
}

/** Schedule X and narcotic items are controlled, whatever was sent. */
export const controlledFor = (details: DrugDetails): DrugDetails =>
  details.schedule === 'x' || details.schedule === 'narcotic'
    ? { ...details, controlled: true }
    : details;

/**
 * An item that is not controlled, added or renamed beside a controlled one of the same generic
 * name in the same form, archived or not, leaves a second audit entry. Archiving a controlled
 * item and adding it again under another spelling of its strength breaks no rule in any one
 * request, and without this it would take the item out of its schedule with no `reclassify`.
 */
export async function traceBesideControlled(writer: Writer, row: DrugRow): Promise<void> {
  if (row.controlled) return;
  if (await hasControlledSibling(writer.txClient, row.generic_name, row.form, row.id)) {
    writer.audit('beside_controlled', 'drug', row.id);
  }
}

/** What a new item will be, refused (409) when the hospital has exactly this one. Reads only. */
export async function prepareDrug(writer: Writer, body: DrugCreate): Promise<DrugDetails> {
  const details = controlledFor({
    type: body.type,
    genericName: cleanName(body.genericName),
    brandName: tidyOptional(body.brandName, NAME_MAX),
    form: body.form,
    strength: tidyOptional(body.strength, SHORT_MAX),
    unit: tidyOptional(body.unit, SHORT_MAX),
    schedule: body.schedule,
    controlled: body.controlled ?? false,
    taxClass: body.taxClass,
    reorderLevel: body.reorderLevel ?? null,
  });
  if (await drugExists(writer.txClient, details)) throw exists();
  return details;
}

/** Adds the item, audited and announced. */
export async function writeDrug(writer: Writer, details: DrugDetails): Promise<DrugRow> {
  let row: DrugRow;
  try {
    row = await insertDrug(writer.txClient, details);
  } catch (error) {
    // Two requests for the same new item at once: the database lets one through.
    if (isDrugExists(error)) throw exists();
    throw error;
  }
  writer.audit('create', 'drug', row.id);
  await traceBesideControlled(writer, row);
  await writer.emit('master.changed', row.id, { kind: 'drug', change: 'created' });
  return row;
}

/** Items loaded from a file by the import centre, one row each, as `POST /drugs` adds them. */
export const drugImport: ImportKind<DrugDetails> = {
  kind: 'drugs',
  feature: 'drugs',
  permissions: ['drug:manage'],
  body: DrugCreate,
  columns: [
    { field: 'type', required: true, type: 'enum', values: DRUG_TYPES },
    { field: 'genericName', required: true, type: 'text' },
    { field: 'brandName', required: false, type: 'text' },
    { field: 'form', required: true, type: 'enum', values: DRUG_FORMS },
    { field: 'strength', required: false, type: 'text' },
    { field: 'unit', required: false, type: 'text' },
    { field: 'schedule', required: true, type: 'enum', values: DRUG_SCHEDULES },
    { field: 'controlled', required: false, type: 'boolean' },
    { field: 'taxClass', required: true, type: 'enum', values: TAX_CLASSES },
    { field: 'reorderLevel', required: false, type: 'integer' },
  ],
  async prepare(writer, body) {
    const details = await prepareDrug(writer, body as DrugCreate);
    // The identity `drugs_same` compares, so two rows of one file for the same item are one.
    const key = [details.genericName, details.brandName ?? '', details.form, details.strength ?? '']
      .map((part) => part.replace(/[‌‍]/g, '').toLowerCase())
      .join('\u0000');
    return { value: details, key };
  },
  write: async (writer, details) => {
    await writeDrug(writer, details);
  },
};
