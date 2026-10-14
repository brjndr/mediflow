import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { searchTerm } from '../../core/http/text.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { todayAtHospital } from '../../core/tenancy/today.js';
import {
  cleanDescription,
  cleanName,
  invalid,
  noSuchList,
  prepareService,
  writeService,
} from './create.js';
import {
  dayBefore,
  findPrice,
  findService,
  insertPrice,
  isCalendarDate,
  isPriceOverlap,
  latestPrice,
  listPriceLists,
  listPrices,
  lockService,
  priceListId,
  searchServices,
  serviceExists,
  setArchived,
  setLastDay,
  updateService,
  withdrawPrice,
  type PriceRow,
  type ServiceRow,
} from './repository.js';
import {
  PriceListList,
  Service,
  SERVICE_SCHEMAS,
  ServiceCreate,
  ServicePage,
  ServicePrice,
  ServicePriceCreate,
  ServicePriceListQuery,
  ServicePricePage,
  ServiceSearchRequest,
  ServiceUpdate,
} from './schemas.js';

const FEATURE = 'services';
const READ = 'service:read';
const MANAGE = 'service:manage';

const priceView = (row: PriceRow): ServicePrice => ({
  id: row.id,
  serviceId: row.service_id,
  priceListId: row.price_list_id,
  amountMinor: row.amount_minor,
  effectiveFrom: row.effective_from,
  ...(row.effective_to === null ? {} : { effectiveTo: row.effective_to }),
});

const view = (row: ServiceRow): Service => ({
  id: row.id,
  tenantId: row.tenant_id,
  code: row.code,
  name: row.name,
  category: row.category,
  taxClass: row.tax_class,
  ...(row.description === null ? {} : { description: row.description }),
  archived: row.archived,
  version: row.version,
  ...(row.price_id === null ||
  row.price_list_id === null ||
  row.amount_minor === null ||
  row.effective_from === null
    ? {}
    : {
        currentPrice: priceView({
          id: row.price_id,
          service_id: row.id,
          price_list_id: row.price_list_id,
          amount_minor: row.amount_minor,
          effective_from: row.effective_from,
          effective_to: row.effective_to,
        }),
      }),
});

// One answer for a service that does not exist and one of another hospital.
const notFound = () => new HttpError(404, 'service_not_found', 'No such service');
const priceConflict = () =>
  new HttpError(409, 'price_date_conflict', 'A price is already scheduled for this service');

const OTHER_HOSPITAL =
  ' A service of another hospital answers 404 service_not_found, the same as one that does not exist.';
const OTHER_LIST =
  " A `priceListId` must be a price list of the session's own hospital: any other, known elsewhere or not, answers 404 price_list_not_found.";

export const serviceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of SERVICE_SCHEMAS) app.addSchema(schema);

  const Params = Type.Object({ serviceId: Type.String({ maxLength: 64 }) });

  /** The service as it is after the request's own changes, with today's price. */
  async function saved(request: FastifyRequest, id: string, today: string): Promise<Service> {
    const row = await findService(request.txClient, id, today);
    if (!row) throw notFound();
    return view(row);
  }

  app.get(
    '/price-lists',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listPriceLists',
        tags: ['services'],
        description:
          'The price lists of the active tenant, the standard one first. Every hospital has one standard list; others (for a payer or a room class) come later.',
        response: { 200: ref(PriceListList), ...errors(401, 403, 409, 429) },
      },
    },
    async (request) => ({ items: await listPriceLists(request.txClient) }),
  );

  app.post(
    '/services/search',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'searchServices',
        tags: ['services'],
        description:
          'The services the active tenant can charge for, by name, each with the price in force on its standard price list today, where today is the date at the hospital in its own timezone. Every word of `q` must be in the code or the name, in any order. Archived services are listed only when asked for. It reads data only. What is searched for travels in the body, never in a query string: the same search is made from prescribing, ordering and billing screens while a patient record is open, and a search term beside a patient id in an access log is patient data. The API does not log the body. `total` comes with the first page.',
        body: ref(ServiceSearchRequest),
        response: { 200: ref(ServicePage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as ServiceSearchRequest;
      const result = await searchServices(
        request.txClient,
        {
          q: searchTerm(body.q),
          category: body.category,
          archived: body.archived ?? false,
          cursor: body.cursor,
          limit: body.limit ?? DEFAULT_PAGE_SIZE,
        },
        await todayAtHospital(request.txClient),
      );
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: result.rows.map(view),
        nextCursor: result.nextCursor,
        ...(result.total === undefined ? {} : { total: result.total }),
      };
    },
  );

  app.post(
    '/services',
    {
      // No patient data in the answer, so a replay can return it whole.
      config: { permissions: [MANAGE], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createService',
        tags: ['services'],
        headers: IdempotencyHeaders,
        description:
          "Adds a service. The hospital is the session's: the body carries no tenant. The code is the service's identity on bills and cannot be changed later; one already used by a service of the hospital, archived or not, whatever its capitals, is refused with 409 service_code_taken. `priceMinor`, when given, is its price on the standard list from today.",
        body: ref(ServiceCreate),
        response: { 201: ref(Service), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const service = await prepareService(request, request.body as ServiceCreate);
      const id = await writeService(request, service);
      const today = service.today;
      return reply.status(201).send(await saved(request, id, today));
    },
  );

  app.get(
    '/services/:serviceId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getService',
        tags: ['services'],
        description:
          'One service, with the price in force today on the standard list.' + OTHER_HOSPITAL,
        params: Params,
        response: { 200: ref(Service), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) =>
      saved(request, request.params.serviceId, await todayAtHospital(request.txClient)),
  );

  app.patch(
    '/services/:serviceId',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'updateService',
        tags: ['services'],
        description:
          'Changes a service: its name, category, tax class or description, never its code. Send the version the change was made from: 409 conflict when the service has changed since. Sending what the service already has changes nothing. A price is not changed here: see the prices of a service.' +
          OTHER_HOSPITAL,
        params: Params,
        body: ref(ServiceUpdate),
        response: { 200: ref(Service), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as ServiceUpdate;
      // Locked while the versions are compared, so of two changes made from the same version
      // exactly one goes through.
      const current = await lockService(request.txClient, request.params.serviceId);
      if (!current) throw notFound();
      if (current.version !== body.expectedVersion) {
        throw new HttpError(409, 'conflict', 'The service has changed');
      }
      const next = {
        name: body.name === undefined ? current.name : cleanName(body.name),
        category: body.category ?? current.category,
        taxClass: body.taxClass ?? current.tax_class,
        description:
          body.description === undefined ? current.description : cleanDescription(body.description),
      };
      const today = await todayAtHospital(request.txClient);
      const changed = [
        next.name !== current.name && 'name',
        next.category !== current.category && 'category',
        next.taxClass !== current.tax_class && 'taxClass',
        next.description !== current.description && 'description',
      ].filter((field): field is string => field !== false);
      if (changed.length > 0) {
        await updateService(request.txClient, current.id, next);
        request.audit('update', 'service', current.id);
        // The names of the fields, never their values.
        await request.emit('master.changed', current.id, {
          kind: 'service',
          change: 'updated',
          fields: changed,
        });
      }
      return saved(request, current.id, today);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/services/:serviceId/${action}`,
      {
        config: { permissions: [MANAGE], feature: FEATURE },
        schema: {
          operationId: `${action}Service`,
          tags: ['services'],
          description:
            (action === 'archive'
              ? 'Archives a service: it stays on the charges and bills that name it and is no longer offered for new ones.'
              : 'Brings an archived service back.') +
            ' Doing it twice changes nothing.' +
            OTHER_HOSPITAL,
          params: Params,
          response: { 200: ref(Service), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const current = await lockService(request.txClient, request.params.serviceId);
        if (!current) throw notFound();
        if (await setArchived(request.txClient, current.id, action === 'archive')) {
          request.audit(action, 'service', current.id);
          await request.emit('master.changed', current.id, {
            kind: 'service',
            change: action === 'archive' ? 'archived' : 'restored',
          });
        }
        return saved(request, current.id, await todayAtHospital(request.txClient));
      },
    );
  }

  app.get(
    '/services/:serviceId/prices',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listServicePrices',
        tags: ['services'],
        description:
          "The prices of a service on a price list, newest first: the one in force, those before it and any that is scheduled. Without `priceListId` the hospital's standard list. A withdrawn price is not listed. `total` comes with the first page." +
          OTHER_HOSPITAL +
          OTHER_LIST,
        params: Params,
        querystring: ServicePriceListQuery,
        response: { 200: ref(ServicePricePage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const { serviceId } = request.params;
      if (!(await serviceExists(request.txClient, serviceId))) throw notFound();
      const listId = await priceListId(request.txClient, request.query.priceListId);
      if (!listId) throw noSuchList();
      const list = await listPrices(request.txClient, serviceId, listId, { cursor, limit });
      if (!list) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: list.rows.map(priceView),
        nextCursor: list.nextCursor,
        ...(list.total === undefined ? {} : { total: list.total }),
      };
    },
  );

  app.post(
    '/services/:serviceId/prices',
    {
      config: { permissions: [MANAGE], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'setServicePrice',
        tags: ['services'],
        headers: IdempotencyHeaders,
        description:
          'Gives a service a new price from a date. Prices are never edited, and a charge already posted keeps the price, the tax class and the category it was posted with. The first price of a service may start today at the hospital (its timezone) or later. Once a price is in force, a new one starts tomorrow or later, never today: charges posted this morning used the price that was in force. The price in force then ends the day before the new one starts. At most one price is scheduled at a time: while one is, a second is refused with 409 price_date_conflict until it is withdrawn. An archived service takes no new price (409 service_archived). The service is locked while this is worked out, and an exclusion constraint keeps the periods of a service on a list from overlapping whatever the code does.' +
          OTHER_LIST +
          OTHER_HOSPITAL,
        params: Params,
        body: ref(ServicePriceCreate),
        response: { 201: ref(ServicePrice), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as ServicePriceCreate;
      const from = body.effectiveFrom;
      if (!isCalendarDate(from)) throw invalid('effectiveFrom is not a date');
      // The lock makes two requests for the same service take their turn.
      const service = await lockService(request.txClient, request.params.serviceId);
      if (!service) throw notFound();
      if (service.archived) {
        throw new HttpError(409, 'service_archived', 'An archived service is not priced');
      }
      const listId = await priceListId(request.txClient, body.priceListId);
      if (!listId) throw noSuchList();
      const today = await todayAtHospital(request.txClient);
      const latest = await latestPrice(request.txClient, service.id, listId);
      // At most one price is scheduled at a time.
      if (latest && latest.effective_from > today) throw priceConflict();
      // The first price may start today. Once one is in force, a new one starts tomorrow or
      // later: what was charged this morning stays what it was.
      if (latest ? from <= today : from < today) {
        throw invalid(
          latest ? 'A new price starts tomorrow or later' : 'A price starts today or later',
        );
      }
      let price: PriceRow;
      try {
        // The price before it ends the day before. Nothing else about it changes.
        if (latest) {
          await setLastDay(request.txClient, latest.id, await dayBefore(request.txClient, from));
        }
        price = await insertPrice(request.txClient, {
          serviceId: service.id,
          listId,
          amountMinor: body.amountMinor,
          effectiveFrom: from,
        });
      } catch (error) {
        if (isPriceOverlap(error)) throw priceConflict();
        throw error;
      }
      request.audit('create', 'service_price', price.id);
      await request.emit('master.changed', service.id, {
        kind: 'service_price',
        change: 'created',
        priceId: price.id,
      });
      return reply.status(201).send(priceView(price));
    },
  );

  app.delete(
    '/services/:serviceId/prices/:priceId',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'cancelServicePrice',
        tags: ['services'],
        description:
          'Withdraws a price that has not come into force yet: the price before it stays in force with no end date. A price that is or was in force cannot be withdrawn (409 price_in_force): it is history, and the database refuses it too. A price that is not of this service or hospital, or was withdrawn already, answers 404 price_not_found.' +
          OTHER_HOSPITAL,
        params: Type.Object({
          serviceId: Type.String({ maxLength: 64 }),
          priceId: Type.String({ maxLength: 64 }),
        }),
        response: {
          204: Type.Null({ description: 'Withdrawn' }),
          ...errors(401, 403, 404, 409, 429),
        },
      },
    },
    async (request, reply) => {
      const service = await lockService(request.txClient, request.params.serviceId);
      if (!service) throw notFound();
      const price = await findPrice(request.txClient, service.id, request.params.priceId);
      if (!price) throw new HttpError(404, 'price_not_found', 'No such price');
      if (price.effective_from <= (await todayAtHospital(request.txClient))) {
        throw new HttpError(
          409,
          'price_in_force',
          'A price that is or was in force is not withdrawn',
        );
      }
      await withdrawPrice(request.txClient, price.id);
      // Only the newest price can be a scheduled one, so the one before it is the one in force:
      // it carries on with no last day.
      const before = await latestPrice(request.txClient, service.id, price.price_list_id);
      if (before) await setLastDay(request.txClient, before.id, null);
      request.audit('delete', 'service_price', price.id);
      await request.emit('master.changed', service.id, {
        kind: 'service_price',
        change: 'withdrawn',
        priceId: price.id,
      });
      return reply.status(204).send(null);
    },
  );
};
