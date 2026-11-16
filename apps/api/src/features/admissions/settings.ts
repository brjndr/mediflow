import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';

/**
 * The hospital's admission settings (#952): `requireDischargeSummary`, off by default. When on,
 * `POST /admissions/{id}/discharge` is 409 `summary_unsigned` until the stay's discharge summary
 * is signed (any discharge type but `absconded`, where nobody is left to sign for).
 */
const FEATURE = 'admissions';
const CONFIGURE = 'admission:configure';

const AdmissionSettings = Type.Object(
  { requireDischargeSummary: Type.Boolean() },
  { $id: 'AdmissionSettings', additionalProperties: false },
);
type AdmissionSettings = Static<typeof AdmissionSettings>;

export const ADMISSION_SETTINGS_SCHEMAS = [AdmissionSettings] as const;

export async function readAdmissionSettings(client: pg.ClientBase): Promise<AdmissionSettings> {
  const { rows } = await client.query<{ require_discharge_summary: boolean }>(
    'select require_discharge_summary from admission_settings',
  );
  return { requireDischargeSummary: rows[0]?.require_discharge_summary ?? false };
}

/** Whether the stay's summary is signed. A signed row is immutable, so this cannot flip back. */
export async function summarySigned(client: pg.ClientBase, admissionId: string): Promise<boolean> {
  const { rows } = await client.query(
    `select 1 from discharge_summaries where admission_id = $1 and status = 'signed'`,
    [admissionId],
  );
  return rows.length > 0;
}

export const admissionSettingsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of ADMISSION_SETTINGS_SCHEMAS) app.addSchema(schema);

  app.get(
    '/admission-settings',
    {
      config: { permissions: [CONFIGURE], feature: FEATURE },
      schema: {
        operationId: 'getAdmissionSettings',
        tags: ['admissions'],
        description:
          'The hospital settings for admissions (#952): whether a discharge waits for a signed discharge summary. Requires admission:configure.',
        response: { 200: ref(AdmissionSettings), ...errors(401, 403, 429) },
      },
    },
    async (request) => readAdmissionSettings(request.txClient),
  );

  app.put(
    '/admission-settings',
    {
      config: { permissions: [CONFIGURE], feature: FEATURE },
      schema: {
        operationId: 'setAdmissionSettings',
        tags: ['admissions'],
        description:
          'Sets the admission settings. With `requireDischargeSummary` on, a discharge is 409 `summary_unsigned` until the stay’s discharge summary is signed (not for an absconded patient). Audited. Requires admission:configure.',
        body: ref(AdmissionSettings),
        response: { 200: ref(AdmissionSettings), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const userId = request.session?.userId;
      if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
      const body = request.body as AdmissionSettings;
      await request.txClient.query(
        `insert into admission_settings (tenant_id, require_discharge_summary, updated_by)
         values (app_tenant_id(), $1, $2)
         on conflict (tenant_id) do update set
           require_discharge_summary = excluded.require_discharge_summary,
           updated_by = excluded.updated_by, updated_at = now()`,
        [body.requireDischargeSummary, userId],
      );
      request.audit('update', 'admission_settings');
      return readAdmissionSettings(request.txClient);
    },
  );
};
