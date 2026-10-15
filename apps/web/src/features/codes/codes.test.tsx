import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { renderApp, renderWithProviders } from '@/test/render';
import { CodeSearch } from './components/CodeSearch';
import { codeKeys } from './hooks/use-codes';

const HEADING = { name: 'Diagnosis and procedure codes', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const openCodes = async () => {
  const app = renderApp({ entry: '/codes' });
  await screen.findByText('Essential (primary) hypertension');
  return app;
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const search = (text: string) =>
  userEvent.type(screen.getByRole('searchbox', { name: 'Search codes' }), text);
const box = (name = 'Find a diagnosis') => screen.getByRole('combobox', { name });
const options = () =>
  within(screen.getByRole('listbox'))
    .queryAllByRole('option')
    .map((option) => option.textContent);
/** The codes listed in the grid, in order. */
const listed = () =>
  screen
    .getAllByRole('button', { name: /^Add to favourites: / })
    .map((add) => add.getAttribute('aria-label')?.replace('Add to favourites: ', ''));

afterEach(() => {
  vi.unstubAllGlobals();
  server.events.removeAllListeners();
});

describe('the code sets', () => {
  it('are listed a page at a time, the hospital’s favourites first, and never whole', async () => {
    const asked: { limit?: number }[] = [];
    const urls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (!request.url.includes('/api/codes/search')) return;
      urls.push(new URL(request.url).search);
      void request
        .clone()
        .json()
        .then((body) => asked.push(body as { limit?: number }));
    });
    await openCodes();

    expect(screen.getByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('1267 codes'));
    // The favourites of this hospital, then the codes in order.
    expect(listed().slice(0, 5)).toEqual(['E11.9', 'I10', 'J06.9', 'A01.0', 'A09']);
    // One page of a set of more than a thousand.
    expect(listed()).toHaveLength(25);
    expect(asked.every((body) => body.limit === 25)).toBe(true);
    // Nothing of a search is ever in an address.
    expect(urls.every((query) => query === '')).toBe(true);

    await userEvent.click(button('Load more'));
    await waitFor(() => expect(listed()).toHaveLength(50));
  });

  it('are reached from the navigation', async () => {
    renderApp();
    await userEvent.click(
      await screen.findByRole('link', { name: 'Diagnosis and procedure codes' }),
    );

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('are searched on the server by code, with or without its dot, and by words of the title', async () => {
    await openCodes();
    await search('e11');
    await waitFor(() => expect(statuses()).toContain('2 codes'));
    expect(listed()).toEqual(['E11.9', 'E11.2']);

    await userEvent.clear(screen.getByRole('searchbox'));
    await search('e119');
    await waitFor(() => expect(statuses()).toContain('1 code'));

    await userEvent.clear(screen.getByRole('searchbox'));
    await search('diabetes type');
    await waitFor(() => expect(statuses()).toContain('3 codes'));

    await userEvent.clear(screen.getByRole('searchbox'));
    await search('nothing like this');
    expect(await screen.findByText('No code matches this search.')).toBeInTheDocument();
  });

  it('show the procedures, and the favourites alone when asked', async () => {
    await openCodes();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Code set' }), 'Procedures');
    expect(await screen.findByText('Caesarean section')).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('20 codes'));
    expect(listed()[0]).toBe('PR-0003');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Favourites only' }));
    await waitFor(() => expect(statuses()).toContain('1 favourite'));
    expect(screen.queryByText('Appendicectomy')).not.toBeInTheDocument();
  });
});

describe('favourites', () => {
  it('are added and removed, and move to the top of the list', async () => {
    const sent: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method !== 'GET' && !request.url.endsWith('/search'))
        sent.push(`${request.method} ${new URL(request.url).pathname}`);
    });
    await openCodes();
    expect(button('Add to favourites: I10')).toBeUnavailable();
    expect(button('Remove from favourites: A09')).toBeUnavailable();

    await userEvent.click(button('Add to favourites: A09'));
    await waitFor(() => expect(statuses()).toContain('A09 is now a favourite.'));
    await waitFor(() => expect(listed().slice(0, 4)).toEqual(['A09', 'E11.9', 'I10', 'J06.9']));

    await userEvent.click(button('Remove from favourites: I10'));
    await waitFor(() => expect(statuses()).toContain('I10 is no longer a favourite.'));
    await waitFor(() => expect(listed().slice(0, 3)).toEqual(['A09', 'E11.9', 'J06.9']));
    expect(sent).toEqual([
      'PUT /api/codes/icd10_a09/favourite',
      'DELETE /api/codes/icd10_i10/favourite',
    ]);
  });

  it('can be marked twice without harm, and only for a code that exists', async () => {
    const params = { path: { codeId: 'icd10_a09' } };
    await api.PUT('/codes/{codeId}/favourite', { params });
    const again = await api.PUT('/codes/{codeId}/favourite', { params });
    expect(again.data?.favourite).toBe(true);
    await api.DELETE('/codes/{codeId}/favourite', { params });
    const gone = await api.DELETE('/codes/{codeId}/favourite', { params });
    expect(gone.data?.favourite).toBe(false);

    await expect(
      api.PUT('/codes/{codeId}/favourite', { params: { path: { codeId: 'icd10_none' } } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the search box', () => {
  it('offers the hospital’s favourites before anything is typed', async () => {
    await openCodes();
    await userEvent.click(box());

    await waitFor(() =>
      expect(options()).toEqual([
        'E11.9Type 2 diabetes mellitus without complicationsFavourite',
        'I10Essential (primary) hypertensionFavourite',
        'J06.9Acute upper respiratory infection, unspecifiedFavourite',
      ]),
    );
    expect(statuses()).toContain("This hospital's 3 favourites. Type to search all codes.");
  });

  it('finds codes as they are typed, a few at a time, and tells the screen which was chosen', async () => {
    const asked: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (!request.url.endsWith('/codes/search')) return;
      void request
        .clone()
        .json()
        .then((body: { limit?: number; q?: string }) => {
          if (body.limit === 10) asked.push(body.q ?? '');
        });
    });
    await openCodes();
    await userEvent.type(box(), 'fever');

    await waitFor(() =>
      expect(options()).toEqual([
        'A01.0Typhoid fever',
        'A90Dengue fever',
        'R50.9Fever, unspecified',
      ]),
    );
    // One request for what was typed, not one for each letter.
    expect(asked.filter(Boolean)).toEqual(['fever']);

    await userEvent.click(screen.getByRole('option', { name: /Dengue fever/ }));
    await waitFor(() => expect(statuses()).toContain('Chosen: A90 Dengue fever'));
    expect(box()).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('is worked with the keyboard: arrows, Enter and Escape', async () => {
    await openCodes();
    await userEvent.type(box(), 'fever');
    await screen.findByRole('option', { name: /Typhoid fever/ });
    expect(screen.getByRole('option', { name: /Typhoid fever/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('option', { name: /Fever, unspecified/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(box()).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: /Fever, unspecified/ }).id,
    );
    // Past the last comes the first again.
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{ArrowUp}');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(statuses()).toContain('Chosen: A90 Dengue fever'));

    await userEvent.type(box(), 'cough');
    await screen.findByRole('option', { name: /Cough/ });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box()).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers nothing of an earlier search while a new one is on its way', async () => {
    await openCodes();
    await userEvent.type(box(), 'ast');
    await screen.findByRole('option', { name: /Asthma, unspecified/ });

    // The next answer is slow: until it comes, the old match cannot be chosen.
    server.use(
      http.post('*/api/codes/search', async () => {
        await delay(400);
        return undefined;
      }),
    );
    await userEvent.type(box(), 'x');
    expect(options()).toEqual([]);
    await userEvent.keyboard('{Enter}');
    expect(statuses().some((text) => text?.startsWith('Chosen'))).toBe(false);
    expect(box()).toHaveValue('astx');

    await waitFor(() => expect(statuses()).toContain('No code matches.'));
  });

  it('says so, and asks for nothing, where the codes are not open to the person', async () => {
    let asked = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/codes/search')) asked++;
    });
    revokePermission(TENANT_IDS.hospital, 'admin', 'code:read');
    // On a screen of another module, as a clinical screen will use it.
    renderWithProviders(<CodeSearch system="icd10" label="Diagnosis" onSelect={() => {}} />);

    const input = await screen.findByRole('combobox', { name: 'Diagnosis' });
    expect(input).toBeDisabled();
    expect(
      screen.getByText('The diagnosis and procedure codes are not open to you at this hospital.'),
    ).toBeInTheDocument();
    expect(asked).toBe(0);
  });

  it('works on a screen of another module, with its own strings', async () => {
    const chosen: string[] = [];
    renderWithProviders(
      <CodeSearch system="icd10" label="Diagnosis" onSelect={(code) => chosen.push(code.code)} />,
    );
    await userEvent.type(await screen.findByRole('combobox', { name: 'Diagnosis' }), 'cough');
    await userEvent.click(await screen.findByRole('option', { name: /Cough/ }));

    expect(chosen).toEqual(['R05']);
  });

  it('says when nothing matches, and when the search failed', async () => {
    await openCodes();
    await userEvent.type(box(), 'zzzz');
    await waitFor(() => expect(statuses()).toContain('No code matches.'));

    server.use(http.post('*/api/codes/search', () => new HttpResponse(null, { status: 500 })));
    await userEvent.clear(box());
    await userEvent.type(box(), 'asthma');
    await waitFor(() =>
      expect(statuses()).toContain('The codes could not be searched. Type again to retry.'),
    );
    expect(options()).toEqual([]);
  });

  it('searches the code set the screen is showing', async () => {
    await openCodes();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Code set' }), 'Procedures');
    await userEvent.type(box('Find a procedure'), 'knee');

    await waitFor(() =>
      expect(options()).toEqual(['PR-0002Arthroscopy of knee', 'PR-0018Total knee replacement']),
    );
  });
});

describe('a screen that is too narrow', () => {
  it('says the screen needs a wider display, and asks the server for nothing', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    let asked = 0;
    server.use(
      http.post('*/api/codes/search', () => {
        asked++;
        return undefined;
      }),
    );
    renderApp({ entry: '/codes' });

    expect(
      await screen.findByRole('heading', { name: 'This screen needs a wider display' }),
    ).toBeInTheDocument();
    expect(asked).toBe(0);
  });
});

describe('access', () => {
  it('lets someone who may only read search the codes, with no favourites to change', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openCodes();

    expect(screen.queryByRole('button', { name: /favourites: / })).toBeNull();
    // The search box is theirs to use: it is how a diagnosis is recorded.
    await userEvent.type(box(), 'asthma');
    expect(await screen.findByRole('option', { name: /Asthma, unspecified/ })).toBeInTheDocument();
  });

  it('is refused by the server too, whatever the screen offers', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const params = { path: { codeId: 'icd10_a09' } };

    await expect(api.PUT('/codes/{codeId}/favourite', { params })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(api.DELETE('/codes/{codeId}/favourite', { params })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('has no screen and no navigation entry without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'code:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/codes' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Diagnosis and procedure codes' }),
    ).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'codes', false);
    renderApp({ entry: '/codes' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    await expect(api.POST('/codes/search', { body: { system: 'icd10' } })).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('share the codes and never each other’s favourites', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await openCodes();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Favourites only' }));
    await waitFor(() => expect(statuses()).toContain('3 favourites'));
    expect(
      queryClient.getQueryCache().findAll({ queryKey: codeKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: codeKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/codes');
    await screen.findByText('Typhoid fever');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Favourites only' }));
    // The clinic marked one code of its own; the hospital's three are not its favourites.
    await waitFor(() => expect(statuses()).toContain('1 favourite'));
    expect(screen.getByText('Acute upper respiratory infection, unspecified')).toBeInTheDocument();
    expect(screen.queryByText('Essential (primary) hypertension')).not.toBeInTheDocument();
  });

  it('change only their own favourites', async () => {
    // The hospital's admin takes away a favourite both hospitals have.
    await api.DELETE('/codes/{codeId}/favourite', { params: { path: { codeId: 'icd10_j069' } } });
    const own = await api.POST('/codes/search', { body: { system: 'icd10', favourites: true } });
    expect(own.data?.items.map((item) => item.code)).toEqual(['E11.9', 'I10']);

    // The clinic still has it.
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    const theirs = await api.POST('/codes/search', {
      body: { system: 'icd10', favourites: true },
    });
    expect(theirs.data?.items.map((item) => item.code)).toEqual(['J06.9']);
  });
});
