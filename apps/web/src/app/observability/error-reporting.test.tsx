import { screen } from '@testing-library/react';
import { ApiError } from '@/shared/api';
import { sanitizeLog, logger } from '@/shared/lib/logger';
import { createRegistry, Slot } from '@/registry';
import { renderApp, renderWithProviders } from '@/test/render';
import { AppShell } from '../AppShell';
import { RouteErrorFallback } from '../RouteErrorFallback';
import { reportError, resetErrorReporting, startErrorReporting } from './error-reporting';
import { REDACTED, scrubEvent, type OutgoingEvent, type SafeEvent } from './scrub';

// The SDK is replaced by a recorder: these tests are about what we hand it and how we configure
// it, and must never talk to a real service.
const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  globalHandlersIntegration: vi.fn(() => ({ name: 'GlobalHandlers' })),
  linkedErrorsIntegration: vi.fn(() => ({ name: 'LinkedErrors' })),
  dedupeIntegration: vi.fn(() => ({ name: 'Dedupe' })),
}));
vi.mock('@sentry/browser', () => sentry);

const context = { route: '/patients/:patientId', tenantId: 'tenant_1' };

/** Synthetic patient details. If any of these strings leaves the browser, a test fails. */
const PATIENT = {
  name: 'Asha Verma',
  mrn: 'MRN-TEST-00042',
  phone: '+91 98765 43210',
  dob: '1984-03-12',
  diagnosis: 'Type 2 diabetes',
  id: 'pat_8f3a',
};
const SECRETS = [...Object.values(PATIENT), 'sessionid=abc123', 'Bearer tok_live'];

/** An event as the SDK could build it at its most talkative, with patient data in every corner. */
function leakyEvent(): OutgoingEvent {
  const event = {
    event_id: 'a1b2c3',
    timestamp: 1_760_000_000,
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    release: 'web@1.4.0',
    message: `Failed to save ${PATIENT.name}`,
    logentry: { message: `Patient ${PATIENT.mrn} not found` },
    transaction: `/patients/${PATIENT.id}`,
    server_name: 'ward-3-pc',
    user: { id: 'user_admin', email: 'admin@sample-hospital.test', ip_address: '10.0.0.7' },
    request: {
      url: `https://app.test/patients/${PATIENT.id}?phone=${encodeURIComponent(PATIENT.phone)}`,
      query_string: `phone=${PATIENT.phone}`,
      cookies: { session: 'sessionid=abc123' },
      headers: { Authorization: 'Bearer tok_live', Referer: `/patients/${PATIENT.id}` },
      data: { firstName: 'Asha', lastName: 'Verma', dob: PATIENT.dob, phone: PATIENT.phone },
    },
    contexts: {
      response: { status_code: 422, data: { diagnosis: PATIENT.diagnosis, mrn: PATIENT.mrn } },
      state: { patient: PATIENT },
    },
    extra: { patient: PATIENT, body: JSON.stringify(PATIENT) },
    tags: { patientName: PATIENT.name, mrn: PATIENT.mrn },
    breadcrumbs: [
      { category: 'console', message: `loaded ${PATIENT.name} (${PATIENT.mrn})` },
      { category: 'ui.click', message: `button[aria-label="Call ${PATIENT.phone}"]` },
      {
        category: 'fetch',
        data: { url: `/api/patients/${PATIENT.id}`, request_body: JSON.stringify(PATIENT) },
      },
      { category: 'navigation', data: { to: `/patients/${PATIENT.id}` } },
    ],
    exception: {
      values: [
        {
          type: 'TypeError',
          value: `Cannot read diagnosis "${PATIENT.diagnosis}" of ${PATIENT.name}`,
          mechanism: { type: 'onerror', handled: false, data: { patient: PATIENT.mrn } },
          stacktrace: {
            frames: [
              {
                filename: `https://app.test/assets/PatientDetail-abc123.js?patient=${PATIENT.id}`,
                function: 'renderDiagnosis',
                lineno: 42,
                colno: 7,
                in_app: true,
                vars: { patient: PATIENT },
                context_line: `const name = "${PATIENT.name}";`,
                pre_context: [`// ${PATIENT.mrn}`],
              },
            ],
          },
        },
      ],
    },
  };
  return event as OutgoingEvent;
}

afterEach(() => {
  resetErrorReporting();
  vi.clearAllMocks();
});

describe('scrubEvent', () => {
  it('strips request bodies, response bodies and patient fields', () => {
    const sent = scrubEvent(leakyEvent(), context);
    const wire = JSON.stringify(sent);

    for (const secret of SECRETS) expect(wire).not.toContain(secret);
    // Nothing that could hold them survives, named or not.
    for (const field of [
      'request',
      'contexts',
      'extra',
      'breadcrumbs',
      'user',
      'message',
      'logentry',
      'transaction',
      'server_name',
      'vars',
      'context_line',
      'pre_context',
      'cookies',
      'headers',
      'data',
    ]) {
      expect(wire).not.toContain(`"${field}"`);
    }
  });

  it('sends exactly the allowed fields', () => {
    expect(scrubEvent(leakyEvent(), context)).toEqual<SafeEvent>({
      event_id: 'a1b2c3',
      timestamp: 1_760_000_000,
      platform: 'javascript',
      level: 'error',
      environment: 'production',
      release: 'web@1.4.0',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: REDACTED,
            mechanism: { type: 'onerror', handled: false },
            stacktrace: {
              frames: [
                {
                  filename: 'https://app.test/assets/PatientDetail-abc123.js',
                  function: 'renderDiagnosis',
                  lineno: 42,
                  colno: 7,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
      // The route is the declared pattern and the tags are ours, not the event's.
      tags: { route: '/patients/:patientId', tenantId: 'tenant_1' },
    });
  });

  it('keeps an ApiError code, which is never free text, and nothing else as a message', () => {
    const value = (type: string, message: string) =>
      scrubEvent({ exception: { values: [{ type, value: message }] } }, context)?.exception
        .values[0]?.value;
    expect(value('ApiError', 'not_found')).toBe('not_found');
    expect(value('ApiError', 'rate_limited')).toBe('rate_limited');
    // An ApiError-typed message that is not a code is still dropped.
    expect(value('ApiError', `No patient ${PATIENT.name}`)).toBe(REDACTED);
    expect(value('Error', 'not_found')).toBe(REDACTED);
    expect(value('ZodError', `Invalid phone ${PATIENT.phone}`)).toBe(REDACTED);
  });

  it('replaces an error type that is not a plain class name', () => {
    const sent = scrubEvent(
      { exception: { values: [{ type: `Error for ${PATIENT.name}`, value: 'x' }] } },
      context,
    );
    expect(sent?.exception.values[0]?.type).toBe('Error');
  });

  it('scrubs every error in a cause chain', () => {
    const sent = scrubEvent(
      {
        exception: {
          values: [
            { type: 'Error', value: `outer ${PATIENT.mrn}` },
            { type: 'ApiError', value: 'conflict' },
          ],
        },
      },
      context,
    );
    expect(sent?.exception.values.map((entry) => entry.value)).toEqual([REDACTED, 'conflict']);
  });

  it('does not send anything that is not an exception', () => {
    expect(
      scrubEvent({ message: `note about ${PATIENT.name}` } as OutgoingEvent, context),
    ).toBeNull();
    expect(scrubEvent({ exception: { values: [] } }, context)).toBeNull();
  });

  it('omits the tenant tag when there is no active hospital', () => {
    const sent = scrubEvent(
      { exception: { values: [{ type: 'Error', value: 'x' }] } },
      { route: '/login', tenantId: undefined },
    );
    expect(sent?.tags).toEqual({ route: '/login' });
  });
});

describe('startErrorReporting', () => {
  const options = { environment: 'test', getContext: () => context };

  it('does nothing and loads nothing without a DSN', async () => {
    reportError(new Error('queued'));
    await expect(startErrorReporting({ ...options, dsn: undefined })).resolves.toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
    reportError(new Error('later'));
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('collects errors only: no breadcrumbs, no user, bodies, headers, cookies or query strings', async () => {
    await startErrorReporting({ ...options, dsn: 'https://key@errors.example.test/1' });
    const config = sentry.init.mock.calls[0]?.[0];
    expect(config).toMatchObject({
      dsn: 'https://key@errors.example.test/1',
      environment: 'test',
      defaultIntegrations: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
    });
    expect(config.integrations.map((integration: { name: string }) => integration.name)).toEqual([
      'GlobalHandlers',
      'LinkedErrors',
      'Dedupe',
    ]);
    // No tracing and no replay are configured.
    expect(config).not.toHaveProperty('tracesSampleRate');
    expect(config).not.toHaveProperty('replaysSessionSampleRate');
    expect(config.beforeBreadcrumb({ category: 'console', message: PATIENT.name })).toBeNull();
  });

  it('passes every event through the scrubber, with the route and tenant read at send time', async () => {
    let route = '/';
    await startErrorReporting({
      dsn: 'https://key@errors.example.test/1',
      environment: 'test',
      getContext: () => ({ route, tenantId: 'tenant_2' }),
    });
    const { beforeSend } = sentry.init.mock.calls[0]?.[0] ?? {};
    route = '/patients/:patientId';

    const sent = beforeSend(leakyEvent());

    expect(sent.tags).toEqual({ route: '/patients/:patientId', tenantId: 'tenant_2' });
    for (const secret of SECRETS) expect(JSON.stringify(sent)).not.toContain(secret);
  });

  it('sends errors reported before it started, and later ones at once', async () => {
    const early = new Error('early');
    reportError(early);
    expect(sentry.captureException).not.toHaveBeenCalled();

    await startErrorReporting({ ...options, dsn: 'https://key@errors.example.test/1' });
    expect(sentry.captureException).toHaveBeenCalledWith(early);

    const late = new ApiError({ code: 'server', status: 500 });
    reportError(late);
    expect(sentry.captureException).toHaveBeenLastCalledWith(late);
  });

  it('keeps only a bounded number of early errors', async () => {
    for (let index = 0; index < 50; index++) reportError(new Error(`early ${index}`));
    await startErrorReporting({ ...options, dsn: 'https://key@errors.example.test/1' });
    expect(sentry.captureException).toHaveBeenCalledTimes(20);
  });
});

describe('error boundaries report what they catch', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await startErrorReporting({
      dsn: 'https://key@errors.example.test/1',
      environment: 'test',
      getContext: () => context,
    });
  });

  function Broken(): never {
    throw new Error(`cannot render ${PATIENT.name}`);
  }
  const reported = () => sentry.captureException.mock.calls.map(([error]) => error);

  it('the global boundary', async () => {
    renderWithProviders(<Broken />, { session: null });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(reported()).toContainEqual(new Error(`cannot render ${PATIENT.name}`));
    // The screen itself never shows the error.
    expect(screen.queryByText(new RegExp(PATIENT.name))).not.toBeInTheDocument();
  });

  it('a route', async () => {
    renderApp({
      routes: [
        {
          path: '/',
          element: <AppShell />,
          errorElement: <RouteErrorFallback />,
          children: [{ index: true, element: <Broken /> }],
        },
      ],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(reported()).toContainEqual(new Error(`cannot render ${PATIENT.name}`));
  });

  it('a slot contribution, without disturbing its host', async () => {
    const registry = createRegistry([
      {
        id: 'broken',
        titleKey: 'nav.home',
        featureFlag: 'patients',
        routes: [],
        permissions: [],
        extensions: [
          { slot: 'patient.detail.tabs', component: () => Promise.resolve({ default: Broken }) },
        ],
      },
    ]);
    renderWithProviders(
      <>
        <h1>Patient</h1>
        <Slot id="patient.detail.tabs" />
      </>,
      { registry },
    );
    await screen.findByRole('heading', { name: 'Patient' });
    await vi.waitFor(() =>
      expect(reported()).toContainEqual(new Error(`cannot render ${PATIENT.name}`)),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('logger', () => {
  it('writes the event name and the allowed fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('i18n.missing_key', { key: 'common:home.titel' });
    expect(warn).toHaveBeenCalledWith('i18n.missing_key', { key: 'common:home.titel' });

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('notices.archive_failed', {
      code: 'forbidden',
      status: 403,
      tenantId: 'tenant_1',
      route: '/notices',
      requestId: 'req_9',
    });
    expect(error).toHaveBeenCalledWith('notices.archive_failed', {
      code: 'forbidden',
      status: 403,
      tenantId: 'tenant_1',
      route: '/notices',
      requestId: 'req_9',
    });
  });

  it('drops fields it does not know, even when the type checker is bypassed', () => {
    const sneaky = {
      code: 'not_found',
      patientName: PATIENT.name,
      phone: PATIENT.phone,
      patient: PATIENT,
      error: new Error(PATIENT.mrn),
    } as never;
    const entry = sanitizeLog('patients.load_failed', sneaky);
    expect(entry).toEqual({ event: 'patients.load_failed', fields: { code: 'not_found' } });
    for (const secret of SECRETS) expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it('drops an allowed field whose value is not a short token', () => {
    const entry = sanitizeLog('patients.load_failed', {
      code: `Patient ${PATIENT.name} not found`,
      key: PATIENT.phone,
      requestId: { nested: PATIENT.mrn } as never,
      status: Number.NaN,
      count: 3,
    });
    expect(entry.fields).toEqual({ count: 3 });
  });

  it('replaces an event name that is not a static identifier', () => {
    expect(sanitizeLog(`Failed for ${PATIENT.name}`).event).toBe('invalid_event_name');
    expect(sanitizeLog('patients.load_failed').event).toBe('patients.load_failed');
  });
});
