import { HttpError } from '../../core/http/errors.js';
import { tidyLinesOptional, tidyWithin } from '../../core/http/text.js';
import type { ImportKind, Writer } from '../../core/imports/registry.js';
import { todayAtHospital } from '../../core/tenancy/today.js';
import {
  codeTaken,
  insertPrice,
  insertService,
  isCodeTaken,
  priceListId,
  type ServiceDetails,
} from './repository.js';
import {
  DESCRIPTION_MAX,
  MODALITIES,
  NAME_MAX,
  SERVICE_CATEGORIES,
  ServiceCreate,
  TAX_CLASSES,
  type Modality,
  type ServiceCategory,
} from './schemas.js';

export const noSuchList = () => new HttpError(404, 'price_list_not_found', 'No such price list');
export const taken = () =>
  new HttpError(409, 'service_code_taken', 'This hospital has a service of that code');
export const invalid = (message: string) => new HttpError(400, 'validation_failed', message);

/** A name as it is stored, and not empty once it is tidied. */
export function cleanName(name: string): string {
  const tidied = tidyWithin(name, NAME_MAX);
  if (tidied === '') throw invalid('A name is required');
  return tidied;
}

/** An empty description is no description. */
export const cleanDescription = (description: string | undefined): string | null =>
  tidyLinesOptional(description, DESCRIPTION_MAX);

/** A modality only for an imaging service (400 otherwise); none when none is given. */
export function modalityFor(category: ServiceCategory, modality: Modality | null | undefined) {
  if (modality === null || modality === undefined) return null;
  if (category !== 'imaging') throw invalid('Only an imaging service has a modality');
  return modality;
}

export interface NewService {
  code: string;
  details: ServiceDetails;
  priceMinor?: number;
  /** Today at the hospital: the day a first price starts. */
  today: string;
}

/** What a new service will be, refused (409) when its code is taken. Reads only. */
export async function prepareService(writer: Writer, body: ServiceCreate): Promise<NewService> {
  const name = cleanName(body.name);
  if (await codeTaken(writer.txClient, body.code)) throw taken();
  return {
    code: body.code,
    details: {
      name,
      category: body.category,
      taxClass: body.taxClass,
      modality: modalityFor(body.category, body.modality),
      description: cleanDescription(body.description),
    },
    ...(body.priceMinor === undefined ? {} : { priceMinor: body.priceMinor }),
    today: await todayAtHospital(writer.txClient),
  };
}

/** Adds the service, and its first price on the standard list from today, audited and announced. */
export async function writeService(writer: Writer, service: NewService): Promise<string> {
  let id: string;
  try {
    const row = await insertService(writer.txClient, { ...service.details, code: service.code });
    id = row.id;
  } catch (error) {
    // Two requests for the same new code at once: the database lets one through.
    if (isCodeTaken(error)) throw taken();
    throw error;
  }
  if (service.priceMinor !== undefined) {
    const listId = await priceListId(writer.txClient);
    if (!listId) throw noSuchList();
    const price = await insertPrice(writer.txClient, {
      serviceId: id,
      listId,
      amountMinor: service.priceMinor,
      effectiveFrom: service.today,
    });
    // A first price is a price like any other to whoever follows prices.
    writer.audit('create', 'service_price', price.id);
    await writer.emit('master.changed', id, {
      kind: 'service_price',
      change: 'created',
      priceId: price.id,
    });
  }
  writer.audit('create', 'service', id);
  await writer.emit('master.changed', id, { kind: 'service', change: 'created' });
  return id;
}

/** Services loaded from a file by the import centre, one row each, as `POST /services` adds them. */
export const serviceImport: ImportKind<NewService> = {
  kind: 'services',
  feature: 'services',
  permissions: ['service:manage'],
  body: ServiceCreate,
  columns: [
    { field: 'code', required: true, type: 'text' },
    { field: 'name', required: true, type: 'text' },
    { field: 'category', required: true, type: 'enum', values: SERVICE_CATEGORIES },
    { field: 'taxClass', required: true, type: 'enum', values: TAX_CLASSES },
    { field: 'modality', required: false, type: 'enum', values: MODALITIES },
    { field: 'description', required: false, type: 'text' },
    { field: 'priceMinor', required: false, type: 'amount' },
  ],
  async prepare(writer, body) {
    const service = await prepareService(writer, body as ServiceCreate);
    // A code is one service whatever its capitals (`services_code_taken`).
    return { value: service, key: service.code.toLowerCase() };
  },
  write: async (writer, service) => {
    await writeService(writer, service);
  },
};
