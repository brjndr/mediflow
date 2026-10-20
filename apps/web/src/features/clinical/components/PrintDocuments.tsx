import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { RichTextView } from '@/shared/ui/rich-text';
import { Letterhead, useFormatters } from '@/tenancy';
import {
  fetchPrescription,
  fetchVisitSummary,
  recordPrescriptionPrint,
  recordSummaryPrint,
  type VisitSummary,
} from '../api';
import { usePrinting } from '../hooks/use-print';
import { linesInOrder } from '../schemas';
import type { Encounter, Prescription } from '../types';
import { howToTake } from './how-to-take';

/**
 * Printing a prescription or the visit summary (#89), for `encounter:print`. A press records the
 * print on the server (the audit log) first, and the browser's print dialog opens only once it
 * is recorded: a refusal prints nothing and says why. The page is the hospital's letterhead and
 * what the caller may read, held in memory until the dialog closes.
 */
export function PrintPrescriptionButton({
  encounter,
  prescription,
}: {
  encounter: Encounter;
  prescription: Prescription;
}) {
  const { t } = useTranslation('clinical');
  const format = useFormatters();
  // Read afresh: one revised or cancelled since the screen loaded is printed as it is now, and
  // the server refuses one no longer to be given (409 `not_printable`).
  const printing = usePrinting(async (key, signal) => {
    const now = await fetchPrescription(prescription.id, signal);
    await recordPrescriptionPrint(prescription.id, key);
    return now;
  });
  return (
    <PrintControl
      label={t('print.prescription')}
      name={t('print.prescriptionLabel', { time: format.dateTime(prescription.prescribedAt) })}
      printing={printing}
      sheet={(written) => <PrescriptionDocument encounter={encounter} prescription={written} />}
    />
  );
}

/** The whole visit on paper: what the caller may read of it, read afresh and whole. */
export function PrintSummaryButton({ encounter }: { encounter: Encounter }) {
  const { t } = useTranslation('clinical');
  const parts = {
    notes: usePermission('clinicalNote:read'),
    diagnoses: usePermission('diagnosis:read'),
    prescriptions: usePermission('prescription:read'),
  };
  const printing = usePrinting(async (key, signal) => {
    const summary = await fetchVisitSummary(encounter.id, parts, signal);
    await recordSummaryPrint(encounter.id, key);
    return summary;
  });
  return (
    <PrintControl
      label={t('print.summary')}
      printing={printing}
      sheet={(summary) => <SummaryDocument encounter={encounter} summary={summary} />}
    />
  );
}

function PrintControl<Job>({
  label,
  name,
  printing,
  sheet,
}: {
  label: string;
  name?: string;
  printing: ReturnType<typeof usePrinting<Job>>;
  sheet: (job: Job) => ReactNode;
}) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const errorId = useId();
  const refusal = (error: unknown) =>
    isApiError(error) && error.serverCode === 'not_printable'
      ? t('print.notPrintable')
      : tCommon(errorMessageKey(error));
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={name}
        aria-disabled={printing.busy || undefined}
        aria-describedby={printing.error ? errorId : undefined}
        onClick={printing.print}
      >
        {label}
      </Button>
      {printing.error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {refusal(printing.error)}
        </p>
      )}
      {printing.job && (
        <PrintSheet key={printing.job.id} onDone={printing.done}>
          {sheet(printing.job.value)}
        </PrintSheet>
      )}
    </div>
  );
}

/** Who the visit is for, with whom and when: the head of every printed document. */
function VisitHead({ encounter, title }: { encounter: Encounter; title: string }) {
  const { t } = useTranslation('clinical');
  const format = useFormatters();
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">{title}</h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('print.patient')}</dt>
        <dd>{t('detail.patient', { name: encounter.patientName, mrn: encounter.patientMrn })}</dd>
        <dt className="font-medium">{t('detail.doctor')}</dt>
        <dd>{encounter.attendingDoctorName ?? t('detail.noDoctor')}</dd>
        {encounter.departmentName && (
          <>
            <dt className="font-medium">{t('detail.department')}</dt>
            <dd>{encounter.departmentName}</dd>
          </>
        )}
        <dt className="font-medium">{t('print.visit')}</dt>
        <dd>{format.dateTime(encounter.openedAt)}</dd>
      </dl>
    </>
  );
}

function PrintedBy() {
  const { t } = useTranslation('clinical');
  const format = useFormatters();
  const name = useSession()?.user.name ?? '';
  return (
    <p className="mt-8 border-t border-black pt-2 text-xs">
      {t('print.printedBy', { time: format.dateTime(new Date().toISOString()), name })}
    </p>
  );
}

/** The lines still to be taken (a cancelled one is not), in the order written, and the advice. */
function PrescriptionBody({ prescription }: { prescription: Prescription }) {
  const { t } = useTranslation('clinical');
  const lines = linesInOrder(prescription).filter((line) => line.status !== 'cancelled');
  return (
    <>
      <ol className="flex list-decimal flex-col gap-2 pl-6">
        {lines.map((line) => (
          <li key={line.id} className="break-inside-avoid">
            <p className="font-semibold">{line.itemName}</p>
            <p>{howToTake(line, t)}</p>
            {line.instructions && <p>{line.instructions}</p>}
          </li>
        ))}
      </ol>
      {prescription.advice && (
        <div className="mt-4">
          <p className="font-medium">{t('prescriptions.advice')}</p>
          <p className="whitespace-pre-line">{prescription.advice}</p>
        </div>
      )}
    </>
  );
}

function PrescriptionDocument({
  encounter,
  prescription,
}: {
  encounter: Encounter;
  prescription: Prescription;
}) {
  const { t } = useTranslation('clinical');
  const format = useFormatters();
  return (
    <article>
      <VisitHead encounter={encounter} title={t('print.prescriptionTitle')} />
      <PrescriptionBody prescription={prescription} />
      <p className="mt-10">
        {t('prescriptions.writtenBy', {
          time: format.dateTime(prescription.prescribedAt),
          name: prescription.prescribedByName,
        })}
      </p>
      <PrintedBy />
    </article>
  );
}

/**
 * What stands of the visit: the diagnoses not retracted, the signed notes not amended (an
 * amendment says so), and the prescriptions not replaced. A part the caller may not read is left
 * out with no trace, as on the screen.
 */
function SummaryDocument({ encounter, summary }: { encounter: Encounter; summary: VisitSummary }) {
  const { t } = useTranslation('clinical');
  const format = useFormatters();
  const diagnoses = summary.diagnoses?.filter((each) => !each.retractedAt);
  const notes = summary.notes?.filter((each) => each.status === 'signed' && !each.amendedById);
  const prescriptions = summary.prescriptions?.filter((each) => !each.replacedById);
  return (
    <article>
      <VisitHead encounter={encounter} title={t('print.summaryTitle')} />
      {diagnoses && (
        <Part title={t('diagnoses.heading')}>
          {diagnoses.length === 0 ? (
            <p>{t('print.noDiagnoses')}</p>
          ) : (
            <ul className="flex list-disc flex-col gap-1 pl-6">
              {diagnoses.map((each) => (
                <li key={each.id}>
                  {[each.code && `${each.code} ${each.codeTitle ?? ''}`.trim(), each.text]
                    .filter(Boolean)
                    .join(': ')}{' '}
                  ({t(`diagnoses.kind.${each.kind}`)})
                </li>
              ))}
            </ul>
          )}
        </Part>
      )}
      {notes && (
        <Part title={t('notes.heading')}>
          {notes.length === 0 ? (
            <p>{t('print.noNotes')}</p>
          ) : (
            notes.map((note) => (
              <div key={note.id} className="mb-4 break-inside-avoid">
                <p className="font-medium">
                  {t(note.amendsId ? 'print.amendedNote' : 'print.note', {
                    time: format.dateTime(note.signedAt ?? note.updatedAt),
                    name: note.authorName,
                  })}
                </p>
                <RichTextView document={note.body} />
              </div>
            ))
          )}
        </Part>
      )}
      {prescriptions && (
        <Part title={t('prescriptions.heading')}>
          {prescriptions.length === 0 ? (
            <p>{t('print.noPrescriptions')}</p>
          ) : (
            prescriptions.map((each) => (
              <div key={each.id} className="mb-4">
                <p className="mb-1 font-medium">
                  {t('prescriptions.writtenBy', {
                    time: format.dateTime(each.prescribedAt),
                    name: each.prescribedByName,
                  })}
                </p>
                <PrescriptionBody prescription={each} />
              </div>
            ))
          )}
        </Part>
      )}
      <PrintedBy />
    </article>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
