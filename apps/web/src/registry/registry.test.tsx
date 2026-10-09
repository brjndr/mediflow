import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FlaskConical, Receipt } from 'lucide-react';
import { http, HttpResponse } from 'msw';
import { setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { apiFetch } from '@/shared/api';
import type { AccessPolicy } from '@/shared/types';
import { renderApp, renderWithProviders } from '@/test/render';
import { appRegistry, createRegistry, Slot, type FeatureManifest, type SlotProps } from '.';

/** A feature's own translations: titles bundled with the manifest, no screen strings. */
const i18nFor = (title: string): FeatureManifest['i18n'] => ({
  titles: { en: { title } },
  load: () => Promise.resolve({ default: {} }),
});

const NO_ACCESS = { name: 'You do not have access to this page' };
const DENIED_URL = 'http://localhost:3000/api/denied';

const page = (title: string) => () => <h1>{title}</h1>;
const tab = (label: string) => (props: SlotProps) => (
  <p>{props.context?.patientId ? `${label} for ${String(props.context.patientId)}` : label}</p>
);
const loader = <Props,>(component: (props: Props) => React.ReactNode) =>
  vi.fn(() => Promise.resolve({ default: component }));

/** Two features as their manifest.ts files would declare them, with observable lazy loaders. */
function makeFeatures() {
  const loaders = {
    labPage: loader(page('Lab worklist')),
    labTab: loader(tab('Lab results tab')),
    labWidget: loader(tab('Pending lab orders')),
    billingPage: loader(page('Refunds')),
    billingTab: loader(tab('Billing tab')),
  };
  const laboratory: FeatureManifest = {
    id: 'laboratory',
    titleKey: 'title',
    i18n: i18nFor('Laboratory'),
    featureFlag: 'laboratory',
    routes: [{ path: 'lab/worklist', lazy: loaders.labPage, requires: ['clinical:read'] }],
    nav: { icon: FlaskConical, order: 30, requires: ['clinical:read'] },
    permissions: ['clinical:read', 'order:create'],
    extensions: [
      { slot: 'patient.detail.tabs', component: loaders.labTab, requires: ['clinical:read'] },
    ],
    dashboardWidgets: [{ id: 'pending', component: loaders.labWidget, requires: ['order:create'] }],
    settings: { section: 'laboratory', schema: {}, requires: ['order:create'] },
  };
  const billing: FeatureManifest = {
    id: 'billing',
    titleKey: 'title',
    i18n: i18nFor('Billing'),
    featureFlag: 'billing',
    routes: [{ path: 'billing/refunds', lazy: loaders.billingPage, requires: ['billing:refund'] }],
    nav: { icon: Receipt, order: 10, requires: ['billing:read'] },
    permissions: ['billing:read', 'billing:refund'],
    extensions: [
      {
        slot: 'patient.detail.tabs',
        component: loaders.billingTab,
        requires: ['billing:read'],
        order: -1,
      },
    ],
  };
  return { laboratory, billing, loaders };
}

const navLinks = () =>
  within(screen.getByRole('navigation', { name: 'Main navigation' }))
    .getAllByRole('link')
    .map((link) => link.textContent);
const navLink = (name: string) => screen.queryByRole('link', { name });
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });

describe('adding a manifest', () => {
  it('adds its route, nav item and slot content with no other change', async () => {
    const { laboratory, billing } = makeFeatures();
    // Before: only billing is registered.
    const before = renderApp({ registry: createRegistry([billing]) });
    await home();
    expect(navLinks()).toEqual(['Billing']);
    before.unmount();

    // After: one more entry in the list. Nothing else differs.
    const registry = createRegistry([billing, laboratory]);
    const { router } = renderApp({ registry });
    await home();
    expect(navLinks()).toEqual(['Billing', 'Laboratory']);

    await userEvent.click(screen.getByRole('link', { name: 'Laboratory' }));
    expect(await screen.findByRole('heading', { name: 'Lab worklist' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/lab/worklist');
    expect(screen.getByRole('link', { name: 'Laboratory' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('adds its contributions to a slot, in order, with the host context', async () => {
    const { laboratory, billing } = makeFeatures();
    renderWithProviders(<Slot id="patient.detail.tabs" context={{ patientId: 'pat_1' }} />, {
      registry: createRegistry([laboratory, billing]),
    });
    expect(await screen.findByText('Lab results tab for pat_1')).toBeInTheDocument();
    // Billing sets order -1, so it comes first although it was registered second.
    expect(screen.getAllByText(/tab for pat_1/).map((node) => node.textContent)).toEqual([
      'Billing tab for pat_1',
      'Lab results tab for pat_1',
    ]);
  });

  it('shows no navigation when no feature is registered', async () => {
    expect(appRegistry.features).toEqual([]);
    renderApp();
    await home();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('feature flag off', () => {
  it('hides the nav item, blocks the route and never loads the feature', async () => {
    const { laboratory, billing, loaders } = makeFeatures();
    setTenantFeature(TENANT_IDS.hospital, 'laboratory', false);
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ registry: createRegistry([laboratory, billing]), entry: '/lab/worklist' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Lab worklist' })).not.toBeInTheDocument();
    expect(navLinks()).toEqual(['Billing']);
    expect(loaders.labPage).not.toHaveBeenCalled();
  });

  it('contributes nothing to slots or the dashboard', async () => {
    const { laboratory, billing, loaders } = makeFeatures();
    setTenantFeature(TENANT_IDS.hospital, 'laboratory', false);
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderWithProviders(
      <>
        <Slot id="patient.detail.tabs" />
        <Slot id="dashboard.widgets" />
      </>,
      { registry: createRegistry([laboratory, billing]) },
    );
    expect(await screen.findByText('Billing tab')).toBeInTheDocument();
    expect(screen.queryByText('Lab results tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending lab orders')).not.toBeInTheDocument();
    expect(loaders.labTab).not.toHaveBeenCalled();
    expect(loaders.labWidget).not.toHaveBeenCalled();
  });
});

describe('permission absent', () => {
  it('blocks a route the role may not open and never loads it', async () => {
    const { laboratory, billing, loaders } = makeFeatures();
    // The custom billing clerk role holds billing:read but not billing:refund.
    signIn(USER_IDS.billingClerk);
    renderApp({ registry: createRegistry([laboratory, billing]), entry: '/billing/refunds' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(loaders.billingPage).not.toHaveBeenCalled();
    // Nav is checked against its own requirement, and lab needs clinical:read.
    expect(navLinks()).toEqual(['Billing']);
  });

  it('filters slot and dashboard contributions by permission', async () => {
    const { laboratory, billing, loaders } = makeFeatures();
    // The hospital admin can read clinical data but cannot place orders.
    renderWithProviders(
      <>
        <Slot id="patient.detail.tabs" />
        <Slot id="dashboard.widgets" />
      </>,
      { registry: createRegistry([laboratory, billing]) },
    );
    expect(await screen.findByText('Lab results tab')).toBeInTheDocument();
    expect(screen.queryByText('Pending lab orders')).not.toBeInTheDocument();
    expect(loaders.labWidget).not.toHaveBeenCalled();
  });

  it('shows a dashboard widget to a role that holds its permission', async () => {
    const { laboratory, billing } = makeFeatures();
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderWithProviders(<Slot id="dashboard.widgets" />, {
      registry: createRegistry([laboratory, billing]),
    });
    expect(await screen.findByText('Pending lab orders')).toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('follows a switch: the lab module exists at the hospital and not at the clinic', async () => {
    const { laboratory, billing } = makeFeatures();
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { router } = renderApp({
      registry: createRegistry([laboratory, billing]),
      entry: '/lab/worklist',
    });
    expect(await screen.findByRole('heading', { name: 'Lab worklist' })).toBeInTheDocument();
    expect(navLinks()).toEqual(['Billing', 'Laboratory']);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );

    await home();
    // At the clinic the lab is off and this doctor has no billing access.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    await router.navigate('/lab/worklist');
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });
});

describe('policy refresh', () => {
  it('removes a module from an open tab without a reload', async () => {
    const { laboratory, billing } = makeFeatures();
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ registry: createRegistry([laboratory, billing]), entry: '/lab/worklist' });
    expect(await screen.findByRole('heading', { name: 'Lab worklist' })).toBeInTheDocument();
    const shell = screen.getByRole('banner');

    // A platform admin switches the module off; this tab learns of it from a 403.
    setTenantFeature(TENANT_IDS.hospital, 'laboratory', false);
    server.use(http.get(DENIED_URL, () => new HttpResponse(null, { status: 403 })));
    await expect(apiFetch(DENIED_URL)).rejects.toMatchObject({ code: 'forbidden' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    await waitFor(() => expect(navLink('Laboratory')).not.toBeInTheDocument());
    expect(navLink('Billing')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBe(shell);
  });
});

describe('<Slot>', () => {
  it('keeps the other contributions when one fails to render', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { laboratory, billing } = makeFeatures();
    const broken: FeatureManifest = {
      id: 'broken',
      titleKey: 'fixture.broken',
      featureFlag: 'billing',
      routes: [],
      permissions: [],
      extensions: [
        {
          slot: 'patient.detail.tabs',
          component: () =>
            Promise.resolve({
              default: () => {
                throw new Error('boom');
              },
            }),
        },
      ],
    };
    renderWithProviders(
      <>
        <h1>Patient</h1>
        <Slot id="patient.detail.tabs" />
      </>,
      { registry: createRegistry([laboratory, broken, billing]) },
    );
    expect(await screen.findByText('Lab results tab')).toBeInTheDocument();
    expect(screen.getByText('Billing tab')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Patient' })).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });

  it('renders nothing for a slot with no contributions', async () => {
    const { laboratory } = makeFeatures();
    renderWithProviders(
      <ul data-testid="host">
        <Slot id="appointment.row.badges" />
      </ul>,
      { registry: createRegistry([laboratory]) },
    );
    expect(await screen.findByTestId('host')).toBeEmptyDOMElement();
  });
});

describe('registry queries', () => {
  const policy = (overrides: Partial<AccessPolicy>): AccessPolicy => ({
    tenantId: 't1',
    roleId: 'custom',
    permissions: [],
    features: { laboratory: true, billing: true },
    version: '1',
    ...overrides,
  });

  it('lists the features whose flag is on', () => {
    const { laboratory, billing } = makeFeatures();
    const registry = createRegistry([laboratory, billing]);
    const ids = (p: AccessPolicy | null) => registry.enabledFeatures(p).map((f) => f.id);
    expect(ids(policy({}))).toEqual(['laboratory', 'billing']);
    expect(ids(policy({ features: { billing: true } }))).toEqual(['billing']);
    expect(ids(null)).toEqual([]);
  });

  it('lists settings sections the user may manage, for enabled features only', () => {
    const { laboratory, billing } = makeFeatures();
    const registry = createRegistry([laboratory, billing]);
    const sections = (p: AccessPolicy | null) => registry.settingsSections(p).map((s) => s.section);
    const canManage = [{ permission: 'order:create' as const }];
    expect(sections(policy({ permissions: canManage }))).toEqual(['laboratory']);
    expect(sections(policy({}))).toEqual([]);
    expect(sections(policy({ permissions: canManage, features: { billing: true } }))).toEqual([]);
    expect(sections(null)).toEqual([]);
  });

  it('denies everything without a policy', () => {
    const { laboratory, billing } = makeFeatures();
    const registry = createRegistry([laboratory, billing]);
    expect(registry.navItems(null)).toEqual([]);
    expect(registry.contributions('patient.detail.tabs', null)).toEqual([]);
  });
});

describe('manifest validation', () => {
  const valid = (): FeatureManifest => makeFeatures().laboratory;
  const problemsOf = (...manifests: FeatureManifest[]) => {
    try {
      createRegistry(manifests);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  it('accepts valid manifests', () => {
    const { laboratory, billing } = makeFeatures();
    expect(problemsOf(laboratory, billing)).toBe('');
  });

  it('rejects a feature registered twice', () => {
    expect(problemsOf(valid(), valid())).toContain('"laboratory" is registered more than once');
  });

  it('rejects two features claiming the same path', () => {
    const other = { ...valid(), id: 'other' };
    expect(problemsOf(valid(), other)).toContain(
      'route "lab/worklist" is already registered by "laboratory"',
    );
  });

  it('rejects a requirement the feature did not declare', () => {
    const feature = valid();
    feature.permissions = ['order:create'];
    const problems = problemsOf(feature);
    expect(problems).toContain(
      'route "lab/worklist" requires "clinical:read" but does not declare it',
    );
    expect(problems).toContain('nav requires "clinical:read"');
    expect(problems).toContain('extension to "patient.detail.tabs" requires "clinical:read"');
  });

  it('rejects malformed permissions, absolute and reserved paths, and a nav with no route', () => {
    const feature = valid();
    const [route] = feature.routes;
    if (!route) throw new Error('fixture has no route');
    const problems = problemsOf(
      { ...feature, id: 'a', permissions: [...feature.permissions, 'admin' as never] },
      { ...feature, id: 'b', routes: [{ ...route, path: '/lab' }], nav: undefined },
      { ...feature, id: 'c', routes: [{ ...route, path: 'login/sso' }], nav: undefined },
      { ...feature, id: 'd', routes: [] },
      { ...feature, id: '', routes: [], nav: undefined },
      { ...feature, id: 'e', routes: [], nav: undefined, featureFlag: '' },
    );
    expect(problems).toContain('declares "admin", which is not in resource:action form');
    expect(problems).toContain('route "/lab" must be a relative path');
    expect(problems).toContain('route "login/sso" uses a path reserved by the app');
    expect(problems).toContain('Feature "d" nav must link to one of its own routes');
    expect(problems).toContain('A feature has no id');
    expect(problems).toContain('Feature "e" has no featureFlag');
  });

  it('rejects duplicate widget ids within a feature', () => {
    const feature = valid();
    const [widget] = feature.dashboardWidgets ?? [];
    if (!widget) throw new Error('fixture has no widget');
    feature.dashboardWidgets = [widget, widget];
    expect(problemsOf(feature)).toContain('has two widgets with id "pending"');
  });
});
