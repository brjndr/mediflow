import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import { tidyOptional } from '../../core/http/text.js';
import { stockableDrug } from '../drugs/index.js';
import { insertIndent, nextNumber } from './indent-repository.js';
import { lockLocation } from './repository.js';
import { NOTE_MAX } from './schemas.js';

const invalid = (message: string) => new HttpError(400, 'validation_failed', message);

/** A place that is in use, held so it is not archived meanwhile. */
async function placeInUse(request: FastifyRequest, locationId: string, field: string) {
  const location = await lockLocation(request.txClient, locationId, 'share');
  if (!location || location.archived) {
    throw invalid(`${field} is not a place of this hospital that is in use`);
  }
  return location;
}

/**
 * Asks a store for items for a place, in the request's transaction: the checks of
 * `POST /inventory/indents` (two different places in use, the one asked a store, each item in use
 * and once; 400 `validation_failed`). Answers the new indent's id. The caller audits and emits.
 * Used by the indent route itself and by nursing's ward requests (BE-24).
 */
export async function requestIndent(
  request: FastifyRequest,
  input: {
    fromLocationId: string;
    toLocationId: string;
    note?: string | undefined;
    lines: { drugId: string; quantity: number }[];
  },
  requestedBy: string,
): Promise<{ id: string; fromLocationId: string }> {
  if (input.fromLocationId.toLowerCase() === input.toLocationId.toLowerCase()) {
    throw invalid('A place does not indent from itself');
  }
  const from = await placeInUse(request, input.fromLocationId, 'fromLocationId');
  const to = await placeInUse(request, input.toLocationId, 'toLocationId');
  if (to.kind !== 'store') throw invalid('toLocationId is not a store');
  const seen = new Set<string>();
  for (const line of input.lines) {
    const drug = await stockableDrug(request.txClient, line.drugId);
    if (!drug) throw invalid('drugId is not an item of this hospital that is in use');
    if (seen.has(drug.id)) throw invalid('An item is asked for once');
    seen.add(drug.id);
  }
  const number = await nextNumber(request.txClient, 'indent');
  const id = await insertIndent(request.txClient, {
    number,
    fromLocationId: from.id,
    toLocationId: to.id,
    note: tidyOptional(input.note, NOTE_MAX),
    requestedBy,
    lines: input.lines.map((line) => ({
      drugId: line.drugId.toLowerCase(),
      quantity: line.quantity,
    })),
  });
  return { id, fromLocationId: from.id };
}
