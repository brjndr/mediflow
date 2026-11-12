import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyLinesOptional, tidyWithin } from '../../core/http/text.js';
import { lockProfile, readProfile, updateProfile, type ProfileRow } from './repository.js';
import {
  ADDRESS_MAX,
  HOSPITAL_PROFILE_SCHEMAS,
  HospitalProfile,
  HospitalProfileUpdate,
  PHONE_MAX,
  REGISTRATION_MAX,
} from './schemas.js';

const READ = 'hospitalProfile:read';
const MANAGE = 'hospitalProfile:manage';

const view = (row: ProfileRow): HospitalProfile => ({
  ...(row.address === null ? {} : { address: row.address }),
  ...(row.phone === null ? {} : { phone: row.phone }),
  ...(row.registration_number === null ? {} : { registrationNumber: row.registration_number }),
  ...(row.gstin === null ? {} : { gstin: row.gstin }),
  version: row.version,
});

/** One-line text as stored: tidied, and nothing when it is empty. */
function line(text: string | undefined, max: number, current: string | null): string | null {
  if (text === undefined) return current;
  const tidied = tidyWithin(text, max);
  return tidied === '' ? null : tidied;
}

const notFound = () => new HttpError(404, 'hospital_not_found', 'No such hospital');

export const hospitalProfileRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of HOSPITAL_PROFILE_SCHEMAS) app.addSchema(schema);

  app.get(
    '/hospital-profile',
    {
      // No module flag: every hospital has a profile. The hospital is the session's.
      config: { permissions: [READ] },
      schema: {
        operationId: 'getHospitalProfile',
        tags: ['hospital-profile'],
        description:
          'The active hospital’s address, phone, registration number and GSTIN, as printed on its letterhead and invoices.',
        response: { 200: ref(HospitalProfile), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const row = await readProfile(request.txClient);
      if (!row) throw notFound();
      return view(row);
    },
  );

  app.patch(
    '/hospital-profile',
    {
      config: { permissions: [MANAGE] },
      schema: {
        operationId: 'updateHospitalProfile',
        tags: ['hospital-profile'],
        description:
          'Changes the details sent; those left out stay as they are, and an empty text removes one. Send the version the change was made from: 409 conflict when the profile has changed since. The GSTIN is stored in capitals. Sending what the hospital already has changes nothing.',
        body: ref(HospitalProfileUpdate),
        response: { 200: ref(HospitalProfile), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as HospitalProfileUpdate;
      const current = await lockProfile(request.txClient);
      if (!current) throw notFound();
      if (current.version !== body.expectedVersion) {
        throw new HttpError(409, 'conflict', 'The hospital profile has changed');
      }
      const next = {
        address:
          body.address === undefined
            ? current.address
            : tidyLinesOptional(body.address, ADDRESS_MAX),
        phone: line(body.phone, PHONE_MAX, current.phone),
        registration_number: line(
          body.registrationNumber,
          REGISTRATION_MAX,
          current.registration_number,
        ),
        gstin: body.gstin === undefined ? current.gstin : body.gstin.toUpperCase() || null,
      };
      if (
        next.address === current.address &&
        next.phone === current.phone &&
        next.registration_number === current.registration_number &&
        next.gstin === current.gstin
      ) {
        return view(current);
      }
      const row = await updateProfile(request.txClient, next);
      // Ids only: the details are not patient data, and the entity is the hospital itself.
      request.audit('update', 'hospital_profile', request.tenant?.id ?? '');
      return view(row);
    },
  );
};
