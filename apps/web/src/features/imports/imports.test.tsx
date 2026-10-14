import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { api } from '@/shared/api';
import { renderApp } from '@/test/render';
import { chunksOf, importKeys, pollDelay } from './hooks/use-imports';
import { readCsvFile } from './read-file';
import { guessMapping, mappingSchema } from './schemas';
import type { ImportColumn } from './types';

const HEADING = { name: 'Import centre', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
/** A job's progress is read on a timer: long enough for a few reads. */
const JOB = { timeout: 8_000 };

const SERVICES = [
  'Code,Name,Category,Tax class,Price',
  'CONS-1,General consultation,consultation,exempt,500',
  'CONS-2,Specialist consultation,consultation,exempt,"1,250.50"',
].join('\n');

const csv = (text: string, name = 'file.csv') => new File([text], name, { type: 'text/csv' });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const combobox = (name: RegExp | string) => screen.getByRole('combobox', { name });
/** A batch in the list of batches, by the name of its kind (the navigation has the same words). */
const listed = async (kind: string) =>
  within(await screen.findByRole('table', { name: 'Imports' })).findByRole('link', { name: kind });

async function openNew() {
  const app = renderApp({ entry: '/imports/new' });
  await screen.findByRole('heading', { name: 'New import' });
  await waitFor(() => expect(combobox('What the file holds')).toBeEnabled());
  return app;
}

/** Picks a kind and a file on the new import screen. */
async function load(kind: string, text: string) {
  await userEvent.selectOptions(combobox('What the file holds'), kind);
  await userEvent.upload(screen.getByLabelText('CSV file'), csv(text));
}

describe('reading a file', () => {
  it('reads the titles and the rows, and refuses a file it cannot use', async () => {
    const read = await readCsvFile(csv(SERVICES));
    expect(read).toEqual({
      headers: ['Code', 'Name', 'Category', 'Tax class', 'Price'],
      rows: [
        { line: 2, fields: ['CONS-1', 'General consultation', 'consultation', 'exempt', '500'] },
        {
          line: 3,
          fields: ['CONS-2', 'Specialist consultation', 'consultation', 'exempt', '1,250.50'],
        },
      ],
    });
    expect(await readCsvFile(csv(''))).toEqual({ problem: 'file.empty' });
    expect(await readCsvFile(csv('Code,Name\n'))).toEqual({ problem: 'file.noRows' });
    expect(await readCsvFile(csv(`Code\n${'x'.repeat(2001)}`))).toEqual({
      problem: 'file.longValue',
    });
    const rows = Array.from({ length: 20_001 }, (_, index) => `C${index}`).join('\n');
    expect(await readCsvFile(csv(`Code\n${rows}`))).toEqual({ problem: 'file.tooMany' });
  });

  it('matches columns to fields by their titles, each column once', () => {
    const columns: ImportColumn[] = [
      { field: 'code', required: true, type: 'text' },
      { field: 'taxClass', required: true, type: 'enum', values: ['exempt'] },
      { field: 'priceMinor', required: false, type: 'amount' },
      { field: 'name', required: true, type: 'text' },
    ];
    const labels: Record<string, string> = { priceMinor: 'Price', taxClass: 'Tax class' };
    expect(
      guessMapping(
        columns,
        ['CODE', 'tax-class', 'Price ', 'Code'],
        (field) => labels[field] ?? field,
      ),
    ).toEqual({ code: '0', taxClass: '1', priceMinor: '2', name: '' });

    const schema = mappingSchema(columns);
    const result = schema.safeParse({ code: '0', taxClass: '0', priceMinor: '', name: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['taxClass', 'imports:mapping.twice'],
      ['name', 'imports:mapping.required'],
    ]);
  });

  it('refuses a file that is not UTF-8 rather than damage its letters', async () => {
    // "Müller" saved as Windows-1252: the ü is one byte that UTF-8 cannot read.
    const bytes = new Uint8Array([
      0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72,
    ]);
    const file = new File([bytes], 'latin.csv', { type: 'text/csv' });
    expect(await readCsvFile(file)).toEqual({ problem: 'file.encoding' });
  });

  it('sends rows in chunks the API takes, by count and by size', () => {
    const short = Array.from({ length: 2_500 }, (_, index) => ({ line: index + 2, values: ['x'] }));
    expect(chunksOf(short).map((chunk) => chunk.length)).toEqual([1_000, 1_000, 500]);
    // Long addresses in an Indic script: three bytes a letter.
    const long = Array.from({ length: 1_000 }, (_, index) => ({
      line: index + 2,
      values: ['न'.repeat(500)],
    }));
    const chunks = chunksOf(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(1_000);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(JSON.stringify(chunk)).length).toBeLessThan(1_000_000);
    }
  });

  it('asks about a working batch less often the longer it takes', () => {
    const delays = [0, 1, 2, 3, 4, 10].map(pollDelay);
    expect(delays[0]).toBe(1_000);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays.at(-1)).toBe(5_000);
  });
});

describe('importing', () => {
  it('sends a file of services, checks it and writes it', async () => {
    const { router } = await openNew();
    await load('Services and prices', SERVICES);

    expect(await screen.findByText('2 rows read from the file.')).toBeInTheDocument();
    // Matched by their titles; the price column by its label.
    expect(combobox(/^Code/)).toHaveValue('0');
    expect(combobox(/^Price/)).toHaveValue('4');
    expect(combobox(/^Description/)).toHaveValue('');

    await userEvent.click(button('Send and check'));
    await screen.findByRole('heading', { name: 'Import of Services and prices' });
    expect(router.state.location.pathname).toMatch(/^\/imports\/imp_/);
    expect(
      await screen.findByText('Every row can be written. Nothing has been written yet.', {}, JOB),
    ).toBeInTheDocument();

    await userEvent.click(button('Write the records'));
    expect(await screen.findByText('2 records were written.', {}, JOB)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write the records' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Back to the import centre' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
    expect(await listed('Services and prices')).toBeInTheDocument();
  }, 20_000);

  it('shows the report of a file with problems, by line and field, and writes nothing', async () => {
    await openNew();
    await load(
      'Drugs and consumables',
      [
        'Type,Generic name,Form,Schedule,Tax class,Reorder level',
        'medicine,Paracetamol,tablet,none,reduced,10',
        'medicine,,tablet,none,reduced,10',
        'medicine,Cetirizine,lozenge,none,reduced,ten',
        'medicine,PARACETAMOL,tablet,none,reduced,10',
      ].join('\n'),
    );
    await screen.findByText('4 rows read from the file.');
    await userEvent.click(button('Send and check'));

    expect(
      await screen.findByText(/4 problems were found\. Correct the file/, {}, JOB),
    ).toBeInTheDocument();
    const report = await screen.findByRole('table', { name: 'Problems found in the file' });
    expect(report).toHaveTextContent('Generic name');
    expect(report).toHaveTextContent('Required, and empty.');
    expect(report).toHaveTextContent('Not one of the allowed values.');
    expect(report).toHaveTextContent('Not a whole number.');
    expect(report).toHaveTextContent('The same record as an earlier row of the file.');
    // The report holds codes, never what the file said.
    expect(report).not.toHaveTextContent('lozenge');
    expect(screen.queryByRole('button', { name: 'Write the records' })).not.toBeInTheDocument();

    await userEvent.click(button('Give up this batch'));
    expect(await screen.findByText('This batch was given up. Nothing was written.')).toBeVisible();
  }, 20_000);

  it('asks for each required field, and for each column once', async () => {
    await openNew();
    await load('Services and prices', 'Something,Else\nA,B');
    await screen.findByText('1 row read from the file.');
    await userEvent.click(button('Send and check'));

    expect(await screen.findAllByText('Choose the column this field is read from.')).toHaveLength(
      4,
    );
    await userEvent.selectOptions(combobox(/^Code/), 'Column 1: Something');
    await userEvent.selectOptions(combobox(/^Name/), 'Column 1: Something');
    expect(
      await screen.findByText('This column is already chosen for another field.'),
    ).toBeVisible();
  });

  it('says why a file cannot be used', async () => {
    await openNew();
    await load('Services and prices', 'Code,Name\n');

    expect(
      await screen.findByText('The file has a row of titles and nothing else.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send and check' })).not.toBeInTheDocument();
  });

  it('warns before a file of patients is sent', async () => {
    await openNew();
    await userEvent.selectOptions(combobox('What the file holds'), 'Patients');

    expect(screen.getByText(/A file of patients holds patient data/)).toBeInTheDocument();
  });
});

describe('access', () => {
  it('offers only the kinds the person may add one at a time', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient:import');
    setTenantFeature(TENANT_IDS.hospital, 'drugs', false);
    await openNew();

    const offered = screen
      .getAllByRole('option')
      .map((option) => option.textContent)
      .filter((text) => text !== 'Choose a kind of record');
    expect(offered).toEqual(['Services and prices', 'Lab tests']);
    await expect(
      api.POST('/imports', {
        body: { kind: 'patients' },
        params: { header: { 'idempotency-key': 'test-key-0001' } },
      }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('has no screen and no navigation entry without the permission', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/imports' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import centre' })).not.toBeInTheDocument();
    await expect(api.GET('/imports', { params: { query: {} } })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('lets someone who may only read see the batches, with nothing to start one', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'import:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/imports' });

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New import' })).not.toBeInTheDocument();
    renderApp({ entry: '/imports/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'imports', false);
    renderApp({ entry: '/imports' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import centre' })).not.toBeInTheDocument();
    await expect(api.GET('/imports/kinds')).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('keeps one hospital’s batches out of the other, in the cache and on the server', async () => {
    for (const tenant of [TENANT_IDS.hospital, TENANT_IDS.clinic]) {
      grantPermission(tenant, 'doctor', 'import:read');
      grantPermission(tenant, 'doctor', 'import:run');
      grantPermission(tenant, 'doctor', 'service:manage');
    }
    setTenantFeature(TENANT_IDS.clinic, 'imports', true);
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const created = await api.POST('/imports', {
      body: { kind: 'services' },
      params: { header: { 'idempotency-key': 'test-key-0002' } },
    });
    const batchId = created.data?.id ?? '';

    const { queryClient } = renderApp({ entry: '/imports' });
    expect(await listed('Services and prices')).toBeInTheDocument();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: importKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(combobox('Hospital'), TENANT_IDS.clinic);
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(
      queryClient.getQueryCache().findAll({ queryKey: importKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);
    await expect(
      api.GET('/imports/{batchId}', { params: { path: { batchId } } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
