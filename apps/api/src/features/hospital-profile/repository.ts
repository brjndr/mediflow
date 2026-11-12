import type pg from 'pg';

/**
 * The hospital's own row. Row-level security limits every statement to the active hospital, so
 * none names a tenant.
 */
export interface ProfileRow {
  address: string | null;
  phone: string | null;
  registration_number: string | null;
  gstin: string | null;
  version: number;
}

const COLUMNS = 'address, phone, registration_number, gstin, version';

export async function readProfile(client: pg.ClientBase): Promise<ProfileRow | null> {
  const { rows } = await client.query<ProfileRow>(`select ${COLUMNS} from tenants`);
  return rows[0] ?? null;
}

/** The row, held until the end of the request so two changes made from one version cannot both pass. */
export async function lockProfile(client: pg.ClientBase): Promise<ProfileRow | null> {
  const { rows } = await client.query<ProfileRow>(`select ${COLUMNS} from tenants for update`);
  return rows[0] ?? null;
}

export async function updateProfile(
  client: pg.ClientBase,
  next: Omit<ProfileRow, 'version'>,
): Promise<ProfileRow> {
  const { rows } = await client.query<ProfileRow>(
    `update tenants
        set address = $1, phone = $2, registration_number = $3, gstin = $4,
            version = version + 1, updated_at = now()
      returning ${COLUMNS}`,
    [next.address, next.phone, next.registration_number, next.gstin],
  );
  const row = rows[0];
  if (!row) throw new Error('hospital profile was not updated');
  return row;
}
