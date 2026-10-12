import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { MAX_FILE_BYTES, MAX_ROWS, readInvites, type BulkRow, type FileProblem } from '../csv';
import { useSendInvite } from '../hooks/use-staff';
import type { StaffRole } from '../types';

/** What became of one row once sending started. */
type Outcome = { sent: true } | { sent: false; reason: string };

const EXAMPLE = 'name,email,role\nAsha Rao,asha.rao@example.org,Nurse';

/**
 * Invites several people from a CSV file. The file is read in the browser and held in memory
 * only: the person sees every row and what is wrong with it before anything is sent, and each
 * invitation then goes out as its own request, so one bad row does not stop the others.
 */
export function BulkInvite({ roles }: { roles: StaffRole[] }) {
  const { t } = useTranslation('staff');
  const { t: tCommon } = useTranslation();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const invite = useSendInvite();
  const [reading, setReading] = useState(false);
  const [fileProblem, setFileProblem] = useState<FileProblem | 'bulk.file.unreadable' | null>(null);
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stopped, setStopped] = useState(false);
  // One key per row for the life of the file, so sending the rest again never sends a row twice.
  const keys = useRef(new Map<number, string>());

  const reset = () => {
    setRows(null);
    setOutcomes({});
    setProgress(null);
    setStopped(false);
    setFileProblem(null);
    keys.current = new Map();
    if (input.current) input.current.value = '';
  };

  const choose = async (file: File | undefined) => {
    reset();
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return setFileProblem('bulk.file.tooLarge');
    setReading(true);
    try {
      const result = readInvites(await file.text(), roles);
      if ('problem' in result) setFileProblem(result.problem);
      else setRows(result.rows);
    } catch {
      setFileProblem('bulk.file.unreadable');
    } finally {
      setReading(false);
    }
  };

  const waiting = (rows ?? []).filter((row) => row.request && outcomes[row.line]?.sent !== true);
  const sentCount = Object.values(outcomes).filter((outcome) => outcome.sent).length;
  const failedCount = Object.values(outcomes).filter((outcome) => !outcome.sent).length;
  const problemCount = (rows ?? []).filter((row) => row.problem).length;
  const sending = progress !== null;

  const send = async () => {
    setStopped(false);
    let done = 0;
    setProgress({ done, total: waiting.length });
    for (const row of waiting) {
      if (!row.request) continue;
      const key = keys.current.get(row.line) ?? crypto.randomUUID();
      keys.current.set(row.line, key);
      let outcome: Outcome;
      try {
        await invite.mutateAsync({ body: row.request, idempotencyKey: key });
        outcome = { sent: true };
      } catch (error) {
        // The hospital's request allowance is used up: the rest waits, it has not failed.
        if (isApiError(error) && error.serverCode === 'rate_limited') {
          setStopped(true);
          break;
        }
        outcome = {
          sent: false,
          reason:
            isApiError(error) && error.serverCode === 'unknown_role'
              ? t('bulk.problems.role')
              : tCommon(errorMessageKey(error)),
        };
      }
      const result = outcome;
      setOutcomes((current) => ({ ...current, [row.line]: result }));
      setProgress({ done: ++done, total: waiting.length });
    }
    setProgress(null);
  };

  const columns = useMemo<GridColumn<BulkRow>[]>(
    () => [
      { id: 'name', header: t('bulk.columns.name'), value: (row) => row.name, hideable: false },
      { id: 'email', header: t('bulk.columns.email'), value: (row) => row.email },
      { id: 'role', header: t('bulk.columns.role'), value: (row) => row.role },
      {
        id: 'result',
        header: t('bulk.columns.result'),
        value: (row) => {
          if (row.problem) return t(row.problem);
          const outcome = outcomes[row.line];
          if (!outcome) return t('bulk.results.ready');
          return outcome.sent
            ? t('bulk.results.sent')
            : `${t('bulk.results.failed')}: ${outcome.reason}`;
        },
      },
      { id: 'line', header: t('bulk.columns.line'), value: (row) => row.line, align: 'end' },
    ],
    [t, outcomes],
  );

  return (
    <section aria-labelledby="staff-invite-bulk" className="flex flex-col gap-3">
      <h2 id="staff-invite-bulk" className="text-lg font-semibold">
        {t('bulk.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('bulk.description', { max: MAX_ROWS })}</p>
      <figure className="text-sm">
        <figcaption className="text-muted-foreground">{t('bulk.example')}</figcaption>
        <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2">{EXAMPLE}</pre>
      </figure>

      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={inputId} className="flex flex-col gap-1 text-sm font-medium">
          {t('bulk.choose')}
          <input
            id={inputId}
            ref={input}
            type="file"
            accept=".csv,text/csv"
            disabled={sending}
            onChange={(event) => void choose(event.target.files?.[0])}
            className="max-w-full text-sm file:mr-3 file:h-9 file:rounded-md file:border file:bg-background file:px-3 pointer-coarse:file:h-11"
          />
        </label>
        {rows && (
          <Button variant="outline" disabled={sending} onClick={reset}>
            {t('bulk.another')}
          </Button>
        )}
      </div>

      {fileProblem && (
        <p role="alert" className="text-sm text-destructive">
          {t(fileProblem, { max: MAX_ROWS })}
        </p>
      )}

      <p role="status" className="text-sm text-muted-foreground">
        {reading
          ? t('bulk.reading')
          : progress
            ? t('bulk.sending', { done: progress.done, total: progress.total })
            : rows && sentCount + failedCount === 0
              ? `${t('bulk.summary', { ready: waiting.length, total: rows.length })}${
                  problemCount > 0 ? ` ${t('bulk.summaryProblems', { count: problemCount })}` : ''
                }`
              : rows
                ? `${t('bulk.finished', { count: sentCount })}${
                    failedCount > 0 ? ` ${t('bulk.failed', { count: failedCount })}` : ''
                  }`
                : ''}
      </p>
      {stopped && (
        <p role="alert" className="text-sm text-destructive">
          {t('bulk.stopped')}
        </p>
      )}

      {rows && (
        <>
          <DataGrid
            label={t('bulk.gridLabel')}
            columns={columns}
            rows={rows}
            rowId={(row) => String(row.line)}
            rowLabel={(row) => row.name || String(row.line)}
            status="ready"
            emptyMessage={t('bulk.file.empty')}
          />
          {waiting.length > 0 && (
            <Button
              className="self-start"
              disabled={sending}
              aria-busy={sending}
              onClick={() => void send()}
            >
              {t('bulk.send', { count: waiting.length })}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
