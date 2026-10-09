import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { sessionKey } from '@/app/session';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { apiFetch } from '@/shared/api';
import type { AccessPolicy, Permission } from '@/shared/types';
import { useSwitchTenant } from '@/tenancy';
import { renderWithProviders } from '@/test/render';
import {
  Can,
  isAllowed,
  PermissionGuard,
  usePermission,
  usePermissionScope,
  usePolicyRefresh,
} from '.';

const DENIED_URL = 'http://localhost:3000/api/denied';

/** A screen with gated actions, as a feature would write it. */
function Actions() {
  return (
    <div data-testid="screen">
      <Can permission="billing:refund" fallback={<span>Refunds need approval</span>}>
        <button>Refund</button>
      </Can>
      <Can permission="billing:create">
        <button>New invoice</button>
      </Can>
      <Can permission="order:create">
        <button>Place order</button>
      </Can>
      <Can permission="patient:read" featureFlag="laboratory">
        <button>Lab results</button>
      </Can>
      <Can permission={['patient:read', 'patient:delete']}>
        <button>Delete patient</button>
      </Can>
    </div>
  );
}

function Scope({ permission }: { permission: Permission }) {
  const held = usePermission(permission);
  const scope = usePermissionScope(permission);
  return <output>{`${permission} held=${held} scope=${scope}`}</output>;
}

function Refresher(props: Parameters<typeof usePolicyRefresh>[0]) {
  usePolicyRefresh(props);
  return null;
}

function SwitchToClinic() {
  const switchTenant = useSwitchTenant();
  return <button onClick={() => switchTenant.mutate(TENANT_IDS.clinic)}>Go to clinic</button>;
}

const button = (name: string) => screen.queryByRole('button', { name });
const ready = () => screen.findByTestId('screen');

/** Counts calls to the policy endpoint, then lets the mock backend answer. */
function watchPolicyRequests() {
  const requests: { ifNoneMatch: string | null }[] = [];
  server.use(
    http.get('*/api/session/policy', ({ request }) => {
      requests.push({ ifNoneMatch: request.headers.get('If-None-Match') });
      return undefined;
    }),
  );
  return requests;
}

describe('<Can>', () => {
  it('shows an action when the permission is held', async () => {
    renderWithProviders(<Actions />);
    await ready();
    expect(button('Refund')).toBeInTheDocument();
    expect(button('Delete patient')).toBeInTheDocument();
    expect(screen.queryByText('Refunds need approval')).not.toBeInTheDocument();
  });

  it('hides an action when the permission is absent and renders the fallback', async () => {
    signIn(USER_IDS.receptionist);
    renderWithProviders(<Actions />);
    await ready();
    expect(button('New invoice')).toBeInTheDocument();
    expect(button('Refund')).not.toBeInTheDocument();
    expect(screen.getByText('Refunds need approval')).toBeInTheDocument();
  });

  it('requires every permission in a list', async () => {
    signIn(USER_IDS.receptionist);
    renderWithProviders(<Actions />);
    await ready();
    // patient:read is held, patient:delete is not.
    expect(button('Delete patient')).not.toBeInTheDocument();
  });

  it('gives a custom role only what it was granted', async () => {
    signIn(USER_IDS.billingClerk);
    renderWithProviders(<Actions />);
    await ready();
    expect(button('New invoice')).toBeInTheDocument();
    expect(button('Refund')).not.toBeInTheDocument();
    expect(button('Place order')).not.toBeInTheDocument();
  });

  it('hides an action when the module is off, even if the permission is held', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderWithProviders(
      <>
        <Actions />
        <Scope permission="patient:read" />
      </>,
    );
    await ready();
    expect(screen.getByRole('status')).toHaveTextContent('patient:read held=true');
    expect(button('Lab results')).not.toBeInTheDocument();
  });

  it('shows nothing when there is no policy', async () => {
    renderWithProviders(<Actions />, { session: null });
    await ready();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('follows the hospital: the same role differs between two tenants', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderWithProviders(
      <>
        <Actions />
        <SwitchToClinic />
      </>,
    );
    await ready();
    expect(button('Place order')).toBeInTheDocument();
    expect(button('Lab results')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Go to clinic' }));

    await waitFor(() => expect(button('Place order')).not.toBeInTheDocument());
    expect(button('Lab results')).not.toBeInTheDocument();
  });
});

describe('usePermissionScope', () => {
  it.each([
    [USER_IDS.doctor, 'appointment:read', 'held=true scope=own'],
    [USER_IDS.admin, 'appointment:read', 'held=true scope=all'],
    [USER_IDS.doctor, 'billing:refund', 'held=false scope=null'],
  ] as const)('reports the scope for %s on %s', async (userId, permission, expected) => {
    signIn(userId, TENANT_IDS.hospital);
    renderWithProviders(<Scope permission={permission} />);
    expect(await screen.findByText(`${permission} ${expected}`)).toBeInTheDocument();
  });
});

describe('<PermissionGuard>', () => {
  const page = (
    <PermissionGuard requires={['user:manage']} featureFlag="patients">
      <h1>Staff accounts</h1>
    </PermissionGuard>
  );

  it('renders the route when access is allowed', async () => {
    renderWithProviders(page);
    expect(await screen.findByRole('heading', { name: 'Staff accounts' })).toBeInTheDocument();
  });

  it('renders the no-access page, never the route, when the permission is absent', async () => {
    signIn(USER_IDS.receptionist);
    renderWithProviders(page);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Staff accounts' })).not.toBeInTheDocument();
  });

  it('renders the no-access page when the module is off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'patients', false);
    renderWithProviders(page);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
  });
});

describe('policy refresh', () => {
  it('hides the UI after a permission is removed, without a reload', async () => {
    renderWithProviders(
      <>
        <Refresher intervalMs={20} />
        <Actions />
      </>,
    );
    const mounted = await ready();
    expect(button('Refund')).toBeInTheDocument();

    // A hospital admin edits the role on the server.
    revokePermission(TENANT_IDS.hospital, 'admin', 'billing:refund');

    await waitFor(() => expect(button('Refund')).not.toBeInTheDocument());
    expect(screen.getByText('Refunds need approval')).toBeInTheDocument();
    expect(button('New invoice')).toBeInTheDocument();
    // Same mounted screen: the page was updated in place, not reloaded.
    expect(screen.getByTestId('screen')).toBe(mounted);
  });

  it('hides a module that was switched off for the hospital', async () => {
    renderWithProviders(
      <>
        <Refresher intervalMs={20} />
        <Actions />
      </>,
    );
    await ready();
    expect(button('Lab results')).toBeInTheDocument();
    setTenantFeature(TENANT_IDS.hospital, 'laboratory', false);
    await waitFor(() => expect(button('Lab results')).not.toBeInTheDocument());
  });

  it('refreshes once when the API answers 403, however many requests failed', async () => {
    const requests = watchPolicyRequests();
    server.use(http.get(DENIED_URL, () => new HttpResponse(null, { status: 403 })));
    renderWithProviders(
      <>
        <Refresher intervalMs={600_000} />
        <Actions />
      </>,
    );
    await ready();
    revokePermission(TENANT_IDS.hospital, 'admin', 'billing:refund');
    expect(requests).toHaveLength(0);

    await Promise.allSettled([apiFetch(DENIED_URL), apiFetch(DENIED_URL), apiFetch(DENIED_URL)]);

    await waitFor(() => expect(button('Refund')).not.toBeInTheDocument());
    expect(requests).toHaveLength(1);
  });

  it('sends the ETag and leaves the policy untouched while nothing changes', async () => {
    const requests = watchPolicyRequests();
    const { queryClient } = renderWithProviders(
      <>
        <Refresher intervalMs={15} />
        <Actions />
      </>,
    );
    await ready();
    const before = queryClient.getQueryData(sessionKey);

    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(3));

    expect(requests[0]?.ifNoneMatch).toBeNull();
    expect(requests.at(-1)?.ifNoneMatch).toMatch(/^".+"$/);
    expect(queryClient.getQueryData(sessionKey)).toBe(before);
  });

  it('does not poll when there is no active hospital', async () => {
    const requests = watchPolicyRequests();
    signIn(USER_IDS.doctor);
    renderWithProviders(
      <>
        <Refresher intervalMs={10} />
        <Actions />
      </>,
    );
    await ready();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(requests).toHaveLength(0);
  });
});

describe('isAllowed', () => {
  const policy: AccessPolicy = {
    tenantId: 't1',
    roleId: 'custom',
    permissions: [{ permission: 'patient:read', scope: 'department' }],
    features: { patients: true, laboratory: false },
    version: '1',
  };

  it('denies everything without a policy', () => {
    expect(isAllowed(null, {})).toBe(false);
    expect(isAllowed(null, { requires: 'patient:read' })).toBe(false);
  });

  it('needs the flag on and every permission held', () => {
    expect(isAllowed(policy, {})).toBe(true);
    expect(isAllowed(policy, { requires: 'patient:read', featureFlag: 'patients' })).toBe(true);
    expect(isAllowed(policy, { requires: ['patient:read', 'patient:update'] })).toBe(false);
    expect(isAllowed(policy, { requires: 'patient:read', featureFlag: 'laboratory' })).toBe(false);
    // An unknown flag is off, never on by default.
    expect(isAllowed(policy, { featureFlag: 'pharmacy' })).toBe(false);
  });
});
