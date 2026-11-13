import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/app/session';
import { usePatientName } from '@/features/patients';
import { Button } from '@/shared/ui/button';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { RichTextView } from '@/shared/ui/rich-text';
import { Letterhead, useFormatters } from '@/tenancy';
import { fieldLabel, optionLabel } from '../labels';
import type { Certificate, Consent, ConsentDetail } from '../types';
import { SignatureView } from './SignaturePad';

/**
 * "Print" for a signed consent or an issued certificate (#568): the record as it was kept, on the
 * hospital's letterhead, then the browser's print dialog. Reading the record already happened
 * (and is audited) when it was opened; printing adds nothing to it, and it never changes.
 * `children` is the page, mounted only while the dialog is open.
 */
export function PrintRecordButton({ children }: { children: ReactNode }) {
  const { t } = useTranslation('consents');
  const [job, setJob] = useState(0);
  const [printing, setPrinting] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        aria-disabled={printing || undefined}
        onClick={() => {
          if (printing) return;
          setJob((n) => n + 1);
          setPrinting(true);
        }}
      >
        {t('print.action')}
      </Button>
      {printing && (
        <PrintSheet key={job} onDone={() => setPrinting(false)}>
          {children}
        </PrintSheet>
      )}
    </>
  );
}

function PatientLine({ patientId }: { patientId: string }) {
  const { t } = useTranslation('consents');
  const patient = usePatientName(patientId);
  if (!patient.data) return null;
  return (
    <>
      <dt className="font-medium">{t('print.patient')}</dt>
      <dd>
        {t('print.patientValue', {
          name: `${patient.data.firstName} ${patient.data.lastName}`,
          mrn: patient.data.mrn,
        })}
      </dd>
    </>
  );
}

function PrintedBy() {
  const { t } = useTranslation('consents');
  const format = useFormatters();
  const name = useSession()?.user.name ?? '';
  return (
    <p className="mt-8 border-t border-black pt-2 text-xs">
      {t('print.printedBy', { time: format.dateTime(new Date().toISOString()), name })}
    </p>
  );
}

/** A signed consent on paper: its text, the signature, who signed and who recorded it. */
export function ConsentDocument({ consent, detail }: { consent: Consent; detail: ConsentDetail }) {
  const { t } = useTranslation('consents');
  const format = useFormatters();
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">
        {t('view.heading', { procedure: consent.procedureName })}
      </h1>
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <PatientLine patientId={consent.patientId} />
      </dl>
      <RichTextView document={detail.body} className="break-words" />
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('view.signedBy')}</dt>
        <dd>
          {t('view.signer', { name: consent.signerName, role: t(`signer.${consent.signerRole}`) })}
        </dd>
        <dt className="font-medium">{t('view.signedAt')}</dt>
        <dd>{format.dateTime(consent.signedAt)}</dd>
        <dt className="font-medium">{t('view.recordedBy')}</dt>
        <dd>{consent.signedByName}</dd>
        <dt className="font-medium">{t('view.version')}</dt>
        <dd>{t('view.versionValue', { version: consent.templateVersion })}</dd>
      </dl>
      <div className="mt-4 break-inside-avoid">
        {detail.signature ? (
          <SignatureView
            path={detail.signature}
            label={t('view.signatureOf', { name: consent.signerName })}
          />
        ) : (
          <p>{t('view.typedSignature', { name: consent.signerName })}</p>
        )}
      </div>
      <PrintedBy />
    </>
  );
}

/** An issued certificate on paper: its number, the fields of its kind, who issued it. */
export function CertificateDocument({ certificate }: { certificate: Certificate }) {
  const { t } = useTranslation('consents');
  const format = useFormatters();
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">
        {t('certificate.viewHeading', {
          kind: t(`certificate.kind.${certificate.kind}`),
          number: certificate.number,
        })}
      </h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <PatientLine patientId={certificate.patientId} />
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
      <PrintedBy />
    </>
  );
}
