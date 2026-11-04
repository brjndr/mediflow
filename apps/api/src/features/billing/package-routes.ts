import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { postCharge, priceOf } from './posting.js';
import { findCharge, findEncounter, isUuid } from './repository.js';
import {
  Charge,
  PackageApply,
  PackageContents,
  PackageContentsUpdate,
  type PackageApply as Apply,
  type PackageContentsUpdate as Update,
} from './schemas.js';
import { chargeView, FEATURE, requireAll, userIdOf } from './views.js';

/**
 * Packages (#117). A package is a service of category `package` with a flat price of its own;
 * this says what it includes (never billed again on a visit that has it) and what it leaves out
 * (always billed on its own), and applies it to a visit as one charge. The charges it replaces
 * are voided with a pointer to it, never deleted, so the ledger keeps what was done.
 */
const ServiceParams = Type.Object({ serviceId: Type.String({ maxLength: 64 }) });
const EncounterParams = Type.Object({ encounterId: Type.String({ maxLength: 64 }) });

const notFound = () => new HttpError(404, 'service_not_found', 'No such service');

async function packageService(request: FastifyRequest, id: string) {
  if (!isUuid(id)) throw notFound();
  const { rows } = await request.txClient.query<{ category: string; archived: boolean }>(
    'select category, archived from services where id = $1',
    [id],
  );
  const service = rows[0];
  if (!service) throw notFound();
  if (service.category !== 'package') {
    throw new HttpError(409, 'not_a_package', 'This service is not a package');
  }
  return service;
}

async function contentsOf(request: FastifyRequest, id: string) {
  const { rows } = await request.txClient.query<{
    service_id: string;
    code: string;
    name: string;
    kind: 'included' | 'excluded';
  }>(
    `select i.service_id, s.code, s.name, i.kind
       from package_items i
       join services s on s.tenant_id = i.tenant_id and s.id = i.service_id
      where i.package_service_id = $1
      order by i.kind, s.name_lower, i.id`,
    [id],
  );
  return {
    items: rows.map((row) => ({
      serviceId: row.service_id,
      code: row.code,
      name: row.name,
      kind: row.kind,
    })),
  };
}

export const packageRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/services/:serviceId/package',
    {
      config: { permissions: ['charge:read'], feature: FEATURE },
      schema: {
        operationId: 'getPackageContents',
        tags: ['billing'],
        description:
          'What a package service includes and leaves out (#117). A service that is not a package is 409 not_a_package. Requires charge:read with the scope all and the billing feature flag. Audited.',
        params: ServiceParams,
        response: { 200: ref(PackageContents), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'charge:read');
      const { serviceId } = request.params as { serviceId: string };
      await packageService(request, serviceId);
      request.audit('read', 'package', serviceId);
      return contentsOf(request, serviceId.toLowerCase());
    },
  );

  app.put(
    '/services/:serviceId/package',
    {
      config: {
        permissions: ['package:manage', 'charge:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'setPackageContents',
        tags: ['billing'],
        description:
          'Replaces the contents of a package service (#117): the services it includes and those it leaves to be billed separately. A service named twice is 400; the package itself, another package, an archived service or a service of another hospital is 422 invalid_package_item. Changing the contents never changes a package already applied to a visit. The Idempotency-Key header is required. Requires package:manage and charge:read with the scope all and the billing feature flag. Audited.',
        params: ServiceParams,
        headers: RequiredIdempotencyHeaders,
        body: ref(PackageContentsUpdate),
        response: { 200: ref(PackageContents), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      requireAll(request, 'package:manage', 'charge:read');
      const { serviceId } = request.params as { serviceId: string };
      await packageService(request, serviceId);
      const id = serviceId.toLowerCase();
      if (request.replayOf !== null) return contentsOf(request, id);
      // Two saves of one package queue here: the last wins, neither fails on a duplicate.
      await request.txClient.query('select id from services where id = $1 for update', [id]);
      const items = (request.body as Update).items.map((item) => ({
        serviceId: item.serviceId.toLowerCase(),
        kind: item.kind,
      }));
      if (new Set(items.map((item) => item.serviceId)).size !== items.length) {
        throw new HttpError(400, 'validation_failed', 'Each service is named once');
      }
      if (items.some((item) => !isUuid(item.serviceId) || item.serviceId === id)) {
        throw new HttpError(422, 'invalid_package_item', 'That service cannot be in this package');
      }
      if (items.length > 0) {
        const { rows } = await request.txClient.query<{ id: string }>(
          `select id from services
            where id = any($1::uuid[]) and category <> 'package' and not archived`,
          [items.map((item) => item.serviceId)],
        );
        if (rows.length !== items.length) {
          throw new HttpError(
            422,
            'invalid_package_item',
            'Each service must exist, be offered and not be a package',
          );
        }
      }
      await request.txClient.query('delete from package_items where package_service_id = $1', [id]);
      for (const item of items) {
        await request.txClient.query(
          `insert into package_items (tenant_id, package_service_id, service_id, kind)
           values (app_tenant_id(), $1, $2, $3)`,
          [id, item.serviceId, item.kind],
        );
      }
      request.audit('update', 'package', id);
      return contentsOf(request, id);
    },
  );

  app.post(
    '/encounters/:encounterId/packages',
    {
      config: {
        permissions: ['charge:create', 'charge:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'applyPackage',
        tags: ['billing'],
        description:
          'Applies a package to a visit (#117): one pending charge of source package at the package’s price in effect today (never sent by the client). The visit’s pending charges for the services it includes, and any posted for them afterwards, are voided with the flag package_covered, so the package replaces them; a charge already on a draft is left for the desk to take off. An unknown service is 404 service_not_found, one that is not a package 409 not_a_package, an archived one 409 service_archived, one with no price in effect 409 no_price, one with nothing included 409 package_empty, one already applied to the visit 409 package_applied, a cancelled visit 409 encounter_cancelled. The Idempotency-Key header is required. Emits charge.posted. Requires charge:create and charge:read with the scope all and the billing feature flag. Audited.',
        params: EncounterParams,
        headers: RequiredIdempotencyHeaders,
        body: ref(PackageApply),
        response: { 201: ref(Charge), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply: FastifyReply) => {
      requireAll(request, 'charge:create', 'charge:read');
      const { encounterId } = request.params as { encounterId: string };
      const answer = async (chargeId: string) => {
        const row = await findCharge(request.txClient, chargeId);
        if (!row || row.encounter_id !== encounterId.toLowerCase()) {
          throw new HttpError(404, 'charge_not_found', 'No such charge');
        }
        return reply.status(201).send(chargeView(row));
      };
      if (request.replayOf !== null) {
        if (!request.idempotentId) throw new HttpError(404, 'charge_not_found', 'No such charge');
        return answer(request.idempotentId);
      }
      const body = request.body as Apply;
      const visit = isUuid(encounterId)
        ? await request.txClient.query('select id from encounters where id = $1 for update', [
            encounterId,
          ])
        : null;
      // One visit at a time, so two presses cannot both apply the same package, and a charge
      // being posted waits for this to commit. Its status is read after the lock.
      if (!visit?.rowCount) throw new HttpError(404, 'encounter_not_found', 'No such visit');
      const encounter = await findEncounter(request.txClient, encounterId);
      if (!encounter) throw new HttpError(404, 'encounter_not_found', 'No such visit');
      if (encounter.status === 'cancelled') {
        throw new HttpError(409, 'encounter_cancelled', 'A cancelled visit has nothing to bill');
      }
      const service = await packageService(request, body.serviceId);
      if (service.archived) {
        throw new HttpError(409, 'service_archived', 'This package is no longer offered');
      }
      const packageId = body.serviceId.toLowerCase();
      const price = await priceOf(request.tx, packageId);
      if (!price || price.amountMinor === null) {
        throw new HttpError(409, 'no_price', 'This package has no price in effect');
      }
      const included = await request.txClient.query(
        `select 1 from package_items where package_service_id = $1 and kind = 'included' limit 1`,
        [packageId],
      );
      if (included.rowCount === 0) {
        throw new HttpError(409, 'package_empty', 'This package includes nothing yet');
      }
      const applied = await request.txClient.query(
        `select 1 from charges
          where encounter_id = $1 and source = 'package' and service_id = $2 and status <> 'void'
          limit 1`,
        [encounter.id, packageId],
      );
      if (applied.rowCount) {
        throw new HttpError(409, 'package_applied', 'This package is already on the visit');
      }
      const posted = await postCharge(request.tx, {
        encounterId: encounter.id,
        patientId: encounter.patient_id,
        serviceId: packageId,
        source: 'package',
        sourceRef: `package:${randomUUID()}`,
        description: '',
        quantity: 1,
        unitPriceMinor: 0,
        flag: null,
        actorId: userIdOf(request),
      });
      if (!posted) throw notFound();
      await request.txClient.query(
        `update charges set status = 'void', flag = 'package_covered', package_charge_id = $3
          where encounter_id = $1 and status = 'pending' and invoice_id is null
            and source <> 'package'
            and service_id in (select service_id from package_items
                                where package_service_id = $2 and kind = 'included')`,
        [encounter.id, packageId, posted],
      );
      request.idempotentId = posted;
      request.audit('create', 'charge', posted);
      return answer(posted);
    },
  );
};
