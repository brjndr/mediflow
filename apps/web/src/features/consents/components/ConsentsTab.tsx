import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { DetailTab } from '@/features/patients';
import type { SlotProps } from '@/registry';
import { errorMessageKey } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { usePatientCertificates, usePatientConsents } from '../hooks/use-consents';
import { fieldLabel, optionLabel } from '../labels';
import { CERTIFICATE_KINDS } from '../schemas';
import type { Certificate, CertificateKind, Consent } from '../types';
import { CertificateForm } from './CertificateForm';
import { ConsentForm } from './ConsentForm';
import { ConsentView } from './ConsentView';
import { CertificateDocument, PrintRecordButton } from './PrintRecord';

/**
 * The "Consents and certificates" tab of the patient's screen (`patient.detail.tabs`, MR-02,
 * #190). Two lists, newest first, a page at a time: consents signed for the patient (opened to
 * read the text and the signature) and certificates issued (medical, fitness, birth, death).
 * `consent:sign` records a consent and `certificate:issue` a certificate. Neither can be changed
 * once recorded. Given the patient's id only, and reads nothing until the tab is opened.
 */
export default function ConsentsTab({ context }: SlotProps) {
  const { t } = useTranslation('consents');
  const canConsents = usePermission('consent:read');
  const canCertificates = usePermission('certificate:read');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId || (!canConsents && !canCertificates)) return null;
  return (
    <DetailTab id="consents" title={t('tab')}>
      {/* Keyed by the patient: another patient's records are never carried over. */}
      <Records key={patientId} patientId={patientId} />
    </DetailTab>
  );
}

type Panel =
  | { kind: 'sign' }
  | { kind: 'view'; consent: Consent }
  | { kind: 'issue'; certificateKind: CertificateKind }
  | { kind: 'certificate'; certificate: Certificate }
  | null;

function panelKey(panel: Panel): string | null {
  if (!panel) return null;
  if (panel.kind === 'view') return `view:${panel.consent.id}`;
  if (panel.kind === 'certificate') return `certificate:${panel.certificate.id}`;
  if (panel.kind === 'issue') return `issue:${panel.certificateKind}`;
  return 'sign';
}

function Records({ patientId }: { patientId: string }) {
  const { t } = useTranslation('consents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const kindId = useId();
  const canReadConsents = usePermission('consent:read');
  const canReadCertificates = usePermission('certificate:read');
  const canSign = usePermission('consent:sign');
  const canIssue = usePermission('certificate:issue');
  const consents = usePatientConsents(patientId, { enabled: canReadConsents });
  const certificates = usePatientCertificates(patientId, { enabled: canReadCertificates });
  const consentRows = useMemo(
    () => consents.data?.pages.flatMap((page) => page.items) ?? [],
    [consents.data],
  );
  const certificateRows = useMemo(
    () => certificates.data?.pages.flatMap((page) => page.items) ?? [],
    [certificates.data],
  );
  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [kind, setKind] = useState<CertificateKind>('medical');
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  usePanelFocus(panelKey(panel), box, status);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const consentColumns = useMemo<GridColumn<Consent>[]>(
    () => [
      {
        id: 'procedure',
        header: t('columns.procedure'),
        value: (row) => row.procedureName,
        hideable: false,
      },
      {
        id: 'signer',
        header: t('columns.signer'),
        value: (row) => `${row.signerName} (${t(`signer.${row.signerRole}`)})`,
      },
      {
        id: 'method',
        header: t('columns.method'),
        value: (row) => t(`signature.method.${row.signatureMethod}`),
      },
      {
        id: 'signedAt',
        header: t('columns.signedAt'),
        value: (row) => format.dateTime(row.signedAt),
      },
    ],
    [t, format],
  );
  const certificateColumns = useMemo<GridColumn<Certificate>[]>(
    () => [
      {
        id: 'number',
        header: t('columns.number'),
        value: (row) => row.number,
        hideable: false,
      },
      {
        id: 'kind',
        header: t('columns.kind'),
        value: (row) => t(`certificate.kind.${row.kind}`),
      },
      {
        id: 'issuedOn',
        header: t('columns.issuedOn'),
        value: (row) => format.calendarDate(row.issuedOn),
      },
      { id: 'issuedBy', header: t('columns.issuedBy'), value: (row) => row.issuedByName },
    ],
    [t, format],
  );
  const consentActions: GridAction<Consent>[] = [
    {
      id: 'view',
      label: t('view.action'),
      requires: 'consent:read',
      onSelect: (row) => setPanel({ kind: 'view', consent: row }),
    },
  ];
  const certificateActions: GridAction<Certificate>[] = [
    {
      id: 'view',
      label: t('view.action'),
      requires: 'certificate:read',
      onSelect: (row) => setPanel({ kind: 'certificate', certificate: row }),
    },
  ];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('heading')}
      </h2>
      <div ref={box} className="flex flex-col gap-4">
        {/* Always on the page, so what was done is read when it is said. */}
        <p
          ref={status}
          tabIndex={-1}
          role="status"
          className="text-sm outline-none empty:hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {message.text && <span key={message.count}>{message.text}</span>}
        </p>
        {panel?.kind === 'sign' && (
          <ConsentForm
            patientId={patientId}
            onClose={() => setPanel(null)}
            onSigned={(detail) => {
              setPanel(null);
              say(t('consent.done', { procedure: detail.consent.procedureName }));
            }}
          />
        )}
        {panel?.kind === 'view' && (
          <ConsentView consent={panel.consent} onClose={() => setPanel(null)} />
        )}
        {panel?.kind === 'issue' && (
          <CertificateForm
            key={panel.certificateKind}
            patientId={patientId}
            kind={panel.certificateKind}
            onClose={() => setPanel(null)}
            onIssued={(certificate) => {
              setPanel(null);
              say(t('certificate.done', { number: certificate.number }));
            }}
          />
        )}
        {panel?.kind === 'certificate' && (
          <CertificateView certificate={panel.certificate} onClose={() => setPanel(null)} />
        )}

        {canReadConsents && (
          <section aria-label={t('consent.section')} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{t('consent.section')}</h3>
              {canSign && panel?.kind !== 'sign' && (
                <Button type="button" onClick={() => setPanel({ kind: 'sign' })}>
                  {t('consent.action')}
                </Button>
              )}
            </div>
            <DataGrid
              label={t('consent.section')}
              columns={consentColumns}
              rows={consentRows}
              rowId={(row) => row.id}
              rowLabel={(row) => t('consent.rowLabel', { procedure: row.procedureName })}
              actions={consentActions}
              status={consents.isPending ? 'loading' : consents.isError ? 'error' : 'ready'}
              errorMessage={consents.isError ? tCommon(errorMessageKey(consents.error)) : undefined}
              onRetry={() => void consents.refetch()}
              emptyMessage={t('consent.empty')}
              hasNextPage={consents.hasNextPage}
              loadingMore={consents.isFetchingNextPage}
              onLoadMore={() => void consents.fetchNextPage()}
            />
          </section>
        )}

        {canReadCertificates && (
          <section aria-label={t('certificate.section')} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h3 className="font-semibold">{t('certificate.section')}</h3>
              {canIssue && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={kindId} className="text-sm font-medium">
                      {t('certificate.kindLabel')}
                    </label>
                    <select
                      id={kindId}
                      value={kind}
                      onChange={(event) => setKind(event.target.value as CertificateKind)}
                      className="h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11"
                    >
                      {CERTIFICATE_KINDS.map((value) => (
                        <option key={value} value={value}>
                          {t(`certificate.kind.${value}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    type="button"
                    onClick={() => setPanel({ kind: 'issue', certificateKind: kind })}
                  >
                    {t('certificate.action')}
                  </Button>
                </div>
              )}
            </div>
            <DataGrid
              label={t('certificate.section')}
              columns={certificateColumns}
              rows={certificateRows}
              rowId={(row) => row.id}
              rowLabel={(row) => t('certificate.rowLabel', { number: row.number })}
              actions={certificateActions}
              status={certificates.isPending ? 'loading' : certificates.isError ? 'error' : 'ready'}
              errorMessage={
                certificates.isError ? tCommon(errorMessageKey(certificates.error)) : undefined
              }
              onRetry={() => void certificates.refetch()}
              emptyMessage={t('certificate.empty')}
              hasNextPage={certificates.hasNextPage}
              loadingMore={certificates.isFetchingNextPage}
              onLoadMore={() => void certificates.fetchNextPage()}
            />
          </section>
        )}
      </div>
    </section>
  );
}

/** An issued certificate's data, in the order of its kind's form. Read only, for good. */
function CertificateView({
  certificate,
  onClose,
}: {
  certificate: Certificate;
  onClose: () => void;
}) {
  const { t } = useTranslation('consents');
  const format = useFormatters();
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('certificate.viewHeading', {
          kind: t(`certificate.kind.${certificate.kind}`),
          number: certificate.number,
        })}
      </h3>
      <p className="text-sm text-muted-foreground">{t('certificate.final')}</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="font-medium">{t('certificate.issuedOn')}</dt>
        <dd>{format.calendarDate(certificate.issuedOn)}</dd>
        {certificate.layout.map((field) => {
          const value = certificate.fields[field.name];
          if (!value) return null;
          return (
            <div key={field.name} className="contents">
              <dt className="font-medium">{fieldLabel(t, certificate.kind, field)}</dt>
              <dd className="whitespace-pre-line break-words">
                {field.type === 'select'
                  ? optionLabel(t, field, value)
                  : field.type === 'date'
                    ? format.calendarDate(value)
                    : value}
              </dd>
            </div>
          );
        })}
        <dt className="font-medium">{t('columns.issuedBy')}</dt>
        <dd>{certificate.issuedByName}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <PrintRecordButton>
          <CertificateDocument certificate={certificate} />
        </PrintRecordButton>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    </div>
  );
}
