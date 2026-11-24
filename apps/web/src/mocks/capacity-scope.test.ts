import { api } from '@/shared/api';
import { editMockDoctor } from './handlers/doctors';
import { currentPolicy, setRolePermissions, signIn, TENANT_IDS, USER_IDS } from './db';

// GET /appointments/capacity answers within the caller's scope, as the API does (#1136).
type Scope = 'all' | 'own' | 'department';

async function capacityAs(scope: Scope, queueScope: Scope = scope, withQueue = true) {
  // The sample doctor has no profile at the hospital: give them the first one, in dep_h_01.
  editMockDoctor('doc_h_01', { userId: USER_IDS.doctor });
  signIn(USER_IDS.doctor);
  await api.POST('/session/switch-tenant', { body: { tenantId: TENANT_IDS.hospital } });
  const kept = (currentPolicy()?.permissions ?? []).filter(
    (grant) => grant.permission !== 'appointment:read' && grant.permission !== 'queue:read',
  );
  setRolePermissions(TENANT_IDS.hospital, 'doctor', [
    ...kept,
    { permission: 'appointment:read', scope },
    ...(withQueue ? [{ permission: 'queue:read', scope: queueScope }] : []),
  ]);
  const { data } = await api.GET('/appointments/capacity');
  if (!data) throw new Error('no capacity');
  return data;
}

describe('mock GET /appointments/capacity scope', () => {
  it('counts one doctor’s slots and queue with `own`, fewer than the whole hospital', async () => {
    const all = await capacityAs('all');
    const own = await capacityAs('own');
    expect(all.waiting).toBe(6);
    expect(all.inConsult).toBe(1);
    // Their department's tokens that name them or nobody yet.
    expect(own.waiting).toBe(3);
    expect(own.inConsult).toBe(1);
    expect(own.slots).toBeLessThanOrEqual(all.slots);
    if (all.slots > 0) expect(own.slots).toBeLessThan(all.slots);
  });

  it('counts the doctors of the caller’s department with `department`', async () => {
    const all = await capacityAs('all');
    const department = await capacityAs('department');
    const own = await capacityAs('own');
    expect(department.waiting).toBe(3);
    expect(department.slots).toBeGreaterThanOrEqual(own.slots);
    expect(department.slots).toBeLessThanOrEqual(all.slots);
  });

  it('leaves out waiting and inConsult without queue:read', async () => {
    const answer = await capacityAs('all', 'all', false);
    expect(answer).not.toHaveProperty('waiting');
    expect(answer).not.toHaveProperty('inConsult');
  });
});
