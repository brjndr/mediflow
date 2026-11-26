import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  readTriageForPrint,
  TriagePrintout,
  useTriagePrintParts,
  type PrintableTriage,
} from '@/features/triage';
import type { SlotProps } from '@/registry';
import { utcToZoned } from '@/shared/utils/timezone';
import { Letterhead, useFormatters, useTenant } from '@/tenancy';
import { printOpdSheet } from '../api';
import { usePrinting } from '../hooks/use-print';
import type { OpdSheet } from '../types';
import { PrintControl, PrintedBy, Signature } from './PrintDocuments';

/** What the doctor writes by hand, with how much room each is given on the A4 page. */
// The heights keep the whole sheet on one A4 page (checked in `e2e/clinical.spec.ts`).
const WRITING = [
  ['complaint', 'h-10'],
  ['examination', 'h-14'],
  ['diagnosis', 'h-10'],
  ['medicines', 'h-40'],
  ['advice', 'h-10'],
] as const;
const VITALS = ['pulse', 'bloodPressure', 'temperature', 'spo2', 'weight'] as const;

/**
 * "Print OPD sheet" on a queue token (`queue.row.actions`, #1201), for `opdSheet:print`, given
 * ids and values only. Nothing is read until the press: the server records the print and answers
 * the head of the sheet; allergies and the latest vitals are added for whoever may read them.
 */
export default function OpdSheetAction({ context }: SlotProps) {
  const { tokenId, patientId, status, number } = context ?? {};
  if (typeof tokenId !== 'string' || typeof patientId !== 'string' || status === 'cancelled') {
    return null;
  }
  return <PrintSheetButton tokenId={tokenId} patientId={patientId} number={number} />;
}

function PrintSheetButton({
  tokenId,
  patientId,
  number,
}: {
  tokenId: string;
  patientId: string;
  number: unknown;
}) {
  // The printout's words are loaded with the button, so a press never suspends the row.
  const { t } = useTranslation(['clinical', 'triage']);
  const triage = useTriagePrintParts();
  const printing = usePrinting(async (key, signal) => {
    // Each part on its own: one that fails does not lose the other, and the sheet still prints.
    const part = (parts: { allergies: boolean; vitals: boolean }) =>
      readTriageForPrint(patientId, parts, signal).catch(() => null);
    const [sheet, allergies, vitals] = await Promise.all([
      printOpdSheet(tokenId, key, signal),
      part({ allergies: triage.allergies, vitals: false }),
      part({ allergies: false, vitals: triage.vitals }),
    ]);
    return {
      sheet,
      triage: { ...allergies, ...vitals },
      // A blank box must never stand for allergies that could not be read.
      allergiesUnread: allergies === null,
    };
  });
  return (
    <PrintControl
      label={t('opdSheet.print')}
      name={t('opdSheet.printLabel', { number })}
      printing={printing}
      sheet={(job) => <OpdSheetDocument {...job} />}
    />
  );
}

function OpdSheetDocument({
  sheet,
  triage,
  allergiesUnread,
}: {
  sheet: OpdSheet;
  triage: PrintableTriage;
  allergiesUnread: boolean;
}) {
  const { t } = useTranslation('clinical');
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  // Only today's reading: an older one would read as this visit's.
  const today =
    triage.vitals && utcToZoned(triage.vitals.recordedAt, timezone).day === sheet.day
      ? triage.vitals
      : undefined;
  return (
    <article>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">{t('opdSheet.title')}</h1>
      <dl className="mb-4 grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-1">
        <dt className="font-medium">{t('print.patient')}</dt>
        <dd>{t('detail.patient', { name: sheet.patientName, mrn: sheet.patientMrn })}</dd>
        <dt className="font-medium">{t('opdSheet.token')}</dt>
        <dd className="text-lg font-semibold">{sheet.tokenNumber}</dd>
        <dt className="font-medium">{t('detail.doctor')}</dt>
        <dd>{sheet.doctorName ?? ''}</dd>
        <dt className="font-medium">{t('opdSheet.date')}</dt>
        <dd>{format.calendarDate(sheet.day)}</dd>
        <dt className="font-medium">{t('detail.department')}</dt>
        <dd>{sheet.departmentName}</dd>
      </dl>
      <TriagePrintout
        triage={{
          ...(triage.allergies ? { allergies: triage.allergies } : {}),
          ...(today ? { vitals: today } : {}),
        }}
      />
      {!triage.allergies && (
        <Blank title={t('opdSheet.allergies')} height="h-8">
          {allergiesUnread && <p className="font-semibold">{t('opdSheet.allergiesUnread')}</p>}
        </Blank>
      )}
      {/* Always there: today's readings are written by hand. */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2">
        {VITALS.map((each) => (
          <p key={each} className="min-w-28 border-b border-black pb-3">
            {t(`opdSheet.vitals.${each}`)}
          </p>
        ))}
      </div>
      {WRITING.map(([part, height]) => (
        <Blank key={part} title={t(`opdSheet.parts.${part}`)} height={height} />
      ))}
      <Signature name={sheet.doctorName ?? ''} credentials={sheet.doctorCredentials} />
      <PrintedBy />
    </article>
  );
}

function Blank({
  title,
  height,
  children,
}: {
  title: string;
  height: string;
  children?: ReactNode;
}) {
  return (
    <section className="break-inside-avoid border-t border-black pt-1">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className={height}>{children}</div>
    </section>
  );
}
