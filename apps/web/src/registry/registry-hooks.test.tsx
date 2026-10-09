import { render, screen } from '@testing-library/react';
import { signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { renderWithProviders } from '@/test/render';
import { createRegistry, useRegistry, useSettingsSections, type FeatureManifest } from '.';

const feature = (id: string, featureFlag: string, permission: 'billing:refund' | 'order:create') =>
  ({
    id,
    titleKey: 'title',
    i18n: {
      titles: { en: { title: `${id} title` } },
      load: () => Promise.resolve({ default: {} }),
    },
    featureFlag,
    routes: [],
    permissions: [permission],
    settings: { section: id, schema: {}, requires: [permission] },
  }) satisfies FeatureManifest;

const registry = createRegistry([
  feature('billing', 'billing', 'billing:refund'),
  feature('laboratory', 'laboratory', 'order:create'),
]);

function Sections() {
  const sections = useSettingsSections();
  return (
    <ul data-testid="sections">
      {sections.map((section) => (
        <li key={section.featureId}>{section.section}</li>
      ))}
    </ul>
  );
}

const listed = () => screen.getAllByRole('listitem').map((item) => item.textContent);

describe('useSettingsSections', () => {
  it('lists the sections the signed-in role may manage', async () => {
    // The hospital admin may refund but not place orders.
    renderWithProviders(<Sections />, { registry });
    await screen.findByTestId('sections');
    expect(listed()).toEqual(['billing']);
  });

  it('follows the role and the hospital’s modules', async () => {
    // The doctor may place orders at the hospital, where the lab is on.
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const first = renderWithProviders(<Sections />, { registry });
    await screen.findByTestId('sections');
    expect(listed()).toEqual(['laboratory']);
    first.unmount();

    // At the clinic the lab is off, and its doctors cannot place orders anyway.
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderWithProviders(<Sections />, { registry });
    expect(await screen.findByTestId('sections')).toBeEmptyDOMElement();
  });

  it('lists nothing when nobody is signed in', async () => {
    renderWithProviders(<Sections />, { registry, session: null });
    expect(await screen.findByTestId('sections')).toBeEmptyDOMElement();
  });
});

describe('useRegistry', () => {
  it('fails loudly outside a RegistryProvider, instead of running with no features', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Orphan() {
      useRegistry();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow('useRegistry must be used inside a RegistryProvider');
  });
});
