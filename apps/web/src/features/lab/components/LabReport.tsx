import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { Letterhead, useFormatters } from '@/tenancy';
import { useReportPrinting } from '../hooks/use-lab';
import { rangeWords } from '../range-words';
import type { LabOrderResults, LabResult } from '../types';

/**
 * "Print report" (#92), for `labReport:print`: the order's results read afresh, the print
 * recorded on the server (the audit log), and only then the browser's print dialog. A refusal
 * prints nothing and says why under the button.
 */
export function PrintReportButton({ orderId }: { orderId: string }) {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const errorId = useId();
  const printing = useReportPrinting(orderId);
  const refusal = (error: unknown) =>
    isApiError(error) && error.serverCode === 'not_printable'
      ? t('report.notPrintable')
      : tCommon(errorMessageKey(error));
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        aria-disabled={printing.busy || undefined}
        aria-describedby={printing.error ? errorId : undefined}
        onClick={printing.print}
      >
        {t('report.print')}
      </Button>
      {printing.error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {refusal(printing.error)}
        </p>
      )}
      {printing.job && (
        <PrintSheet key={printing.job.id} onDone={printing.done}>
          <LabReportDocument data={printing.job.value} />
        </PrintSheet>
      )}
    </div>
  );
}

/** A test of the report and its newest verified result, if any. */
interface ReportLine {
  labTestId: string;
  name: string;
  result?: LabResult;
}

/**
 * The tests of the order in the catalog's order, each with its newest verified result, then any
 * verified result of a test no longer in the panel. A result not verified is never printed.
 */
function reportLines(data: LabOrderResults): ReportLine[] {
  const newestVerified = new Map<string, LabResult>();
  for (const result of data.results) {
    if (result.status === 'verified') newestVerified.set(result.labTestId, result);
  }
  const lines: ReportLine[] = data.analytes.map((analyte) => ({
    labTestId: analyte.labTestId,
    name: analyte.name,
    result: newestVerified.get(analyte.labTestId),
  }));
  for (const [labTestId, result] of newestVerified) {
    if (!lines.some((line) => line.labTestId === labTestId)) {
      lines.push({ labTestId, name: result.testName, result });
    }
  }
  return lines;
}

/**
 * The report on paper: the hospital's letterhead, who it is for, the sample, each test with its
 * verified result, unit, flag in words and range, who verified, and who printed it and when. A
 * test still to verify is printed as pending, never with a value.
 */
function LabReportDocument({ data }: { data: LabOrderResults }) {
  const { t } = useTranslation('lab');
  const format = useFormatters();
  const printedBy = useSession()?.user.name ?? '';
  const number = (value: number) => format.number(value);
  const lines = reportLines(data);
  const pending = lines.some((line) => !line.result);
  const verifiers = [
    ...new Set(
      lines.flatMap((line) => (line.result?.verifiedByName ? [line.result.verifiedByName] : [])),
    ),
  ];
  const sample = data.sample;
  const cell = 'border-b border-black/40 py-1 pr-3 text-left align-top';
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">{t('report.title', { test: data.itemName })}</h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('results.patient')}</dt>
        <dd>{t('report.patient', { name: data.patientName, mrn: data.patientMrn })}</dd>
        {sample && (
          <>
            <dt className="font-medium">{t('report.accession')}</dt>
            <dd>{sample.accessionId}</dd>
            <dt className="font-medium">{t('results.sample')}</dt>
            <dd>{t(`sampleType.${sample.sampleType}`)}</dd>
            <dt className="font-medium">{t('report.collected')}</dt>
            <dd>{format.dateTime(sample.collectedAt)}</dd>
            {sample.receivedAt && (
              <>
                <dt className="font-medium">{t('report.received')}</dt>
                <dd>{format.dateTime(sample.receivedAt)}</dd>
              </>
            )}
            {sample.partnerLab && (
              <>
                <dt className="font-medium">{t('results.partner')}</dt>
                <dd>
                  {sample.partnerRef
                    ? t('results.partnerWithRef', {
                        partner: sample.partnerLab,
                        ref: sample.partnerRef,
                      })
                    : sample.partnerLab}
                </dd>
              </>
            )}
          </>
        )}
      </dl>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className={cell}>
              {t('results.columns.test')}
            </th>
            <th scope="col" className={cell}>
              {t('results.columns.result')}
            </th>
            <th scope="col" className={cell}>
              {t('results.columns.flag')}
            </th>
            <th scope="col" className={cell}>
              {t('results.columns.range')}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map(({ labTestId, name, result }) => (
            <tr key={labTestId} className="break-inside-avoid">
              <th scope="row" className={`${cell} font-normal`}>
                {name}
                {result?.amendsId && <span className="block text-xs">{t('report.corrected')}</span>}
                {result?.comment && (
                  <span className="block text-xs whitespace-pre-line">{result.comment}</span>
                )}
              </th>
              <td className={`${cell} font-semibold whitespace-pre-line`}>
                {result
                  ? [result.value, result.unit].filter(Boolean).join(' ')
                  : t('report.pending')}
              </td>
              <td className={cell}>{result?.flag ? t(`flag.${result.flag}`) : ''}</td>
              <td className={cell}>{rangeWords(result?.range, t, number)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pending && <p className="mt-3 text-sm">{t('report.pendingNote')}</p>}
      {verifiers.length > 0 && (
        <p className="mt-6">{t('report.verifiedBy', { names: verifiers.join(', ') })}</p>
      )}
      <p className="mt-8 border-t border-black pt-2 text-xs">
        {t('report.printedBy', {
          time: format.dateTime(new Date().toISOString()),
          name: printedBy,
        })}
      </p>
    </>
  );
}
