import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { addFavourite, findCode, removeFavourite, searchCodes } from './repository.js';
import { Code, CODE_SCHEMAS, CodePage, CodeSearchRequest } from './schemas.js';

const FEATURE = 'codes';
const READ = 'code:read';
const MANAGE = 'code:manage';

export const codeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of CODE_SCHEMAS) app.addSchema(schema);

  const Params = Type.Object({ codeId: Type.String({ maxLength: 64 }) });

  app.post(
    '/codes/search',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'searchCodes',
        tags: ['codes'],
        description:
          "Diagnosis and procedure codes, searched on the server: the code sets are large and are never sent whole or bundled into the web app. It reads data only. The search term travels in the body, never in a query string: it is free text typed while a patient's record may be open, and a diagnosis term beside a patient id in an access log is patient data. The API does not log the body. The codes themselves are the same for every hospital; `favourite` is the active tenant's own mark, taken from the session, never from the client. `q` is words in any order: each matches the start of the code (with or without its dot) or the start of a word of the title. The hospital's favourites come first, then the other codes, each in the order of the codes. `favourites: true` gives the favourites only, which is what a search box shows before anything is typed. `total` comes with the first page only. The answer is the active tenant's view and is private to the session: `Cache-Control: private, no-store`.",
        body: ref(CodeSearchRequest),
        response: { 200: ref(CodePage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as CodeSearchRequest;
      const result = await searchCodes(request.txClient, {
        system: body.system,
        q: body.q,
        favouritesOnly: body.favourites ?? false,
        cursor: body.cursor,
        limit: body.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: result.rows,
        nextCursor: result.nextCursor,
        ...(result.total === undefined ? {} : { total: result.total }),
      };
    },
  );

  for (const method of ['PUT', 'DELETE'] as const) {
    const mark = method === 'PUT';
    app.route({
      method,
      url: '/codes/:codeId/favourite',
      // Whoever changes a favourite is answered with the code, so needs to be allowed to read it.
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: mark ? 'addFavouriteCode' : 'removeFavouriteCode',
        tags: ['codes'],
        description:
          (mark
            ? "Marks a code as one of the active tenant's favourites, for every member of its staff."
            : "Takes a code out of the active tenant's favourites.") +
          ' Doing it twice changes nothing. Audited. 404 code_not_found for a code that does not exist.',
        params: Params,
        response: { 200: ref(Code), ...errors(401, 403, 404, 409, 429) },
      },
      handler: async (request) => {
        const { codeId } = request.params as { codeId: string };
        const code = await findCode(request.txClient, codeId);
        if (!code) throw new HttpError(404, 'code_not_found', 'No such code');
        const changed = mark
          ? await addFavourite(request.txClient, code.id)
          : await removeFavourite(request.txClient, code.id);
        if (changed) {
          request.audit(mark ? 'favourite' : 'unfavourite', 'code', code.id);
          await request.emit('master.changed', code.id, {
            kind: 'code_favourite',
            change: mark ? 'added' : 'removed',
          });
        }
        return { ...code, favourite: mark };
      },
    });
  }
};
