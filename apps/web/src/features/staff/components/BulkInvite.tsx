import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useTenant } from '@/tenancy';
import { MAX_FILE_BYTES, MAX_ROWS, readInvites, type BulkRow, type FileProblem } from '../csv';
import { useSendInvite } from '../hooks/use-staff';
import type { StaffRole } from '../types';

/** What became of one row once sending started. A refused row is not tried again. */
type Outcome = { sent: true } | { sent: false; reason: string };

/** Why sending stopped before the end, with rows still waiting. */
type Stop = { kind: 'busy' } | { kind: 'error'; message: string };

/** Refusals that are about the row itself: the next row may well go through. */
const ABOUT_THE_ROW = new Set(['validation_failed', 'unknown_role', 'role_not_allowed']);

/**
 * Invites several people from a CSV file. The file is read in the browser and held in memory
 * only: the person sees every row and what is wrong with it before anything is sent, and each
 * invitation then goes out as its own request, so one bad row does not stop the others.
 *
 * Sending belongs to this screen at this hospital. It stops when the screen is left or the
 * hospital changes, so the rest of a list is never sent unseen, or to another hospital.
 */
export function BulkInvite({ roles }: { roles: StaffRole[] }) {
  const { t } = useTranslation('staff');
  const { t: tCommon } = useTranslation();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const invite = useSendInvite();
  const tenantId = useTenant()?.id;
  const [reading, setReading] = useState(false);
  const [fileProblem, setFileProblem] = useState<FileProblem | 'bulk.file.unreadable' | null>(null);
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stop, setStop] = useState<Stop | null>(null);
  // One key per row for the life of the file, so sending the rest again never sends a row twice.
  const keys = useRef(new Map<number, string>());
  // What the loop looks at before every row: whether this screen is still here, and whose it is.
  const live = useRef({ mounted: true, tenantId });
  useEffect(() => {
    live.current = { mounted: true, tenantId };
    return () => {
      live.current.mounted = false;
    };
  }, [tenantId]);

  const forget = () => {
    setRows(null);
    setOutcomes({});
    setProgress(null);
    setStop(null);
    setFileProblem(null);
    keys.current = new Map();
  };

  const choose = async (file: File | undefined) => {
    forget();
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

  // Rows in order that were neither sent nor refused. A row the server refused stays refused.
  const waiting = (rows ?? []).filter((row) => row.request && outcomes[row.line] === undefined);
  const sentCount = Object.values(outcomes).filter((outcome) => outcome.sent).length;
  const failedCount = Object.values(outcomes).filter((outcome) => !outcome.sent).length;
  const problemCount = (rows ?? []).filter((row) => row.problem).length;
  const sending = progress !== null;

  const send = async () => {
    const startedFor = tenantId;
    const batch = waiting;
    const here = () => live.current.mounted && live.current.tenantId === startedFor;
    setStop(null);
    let done = 0;
    setProgress({ done, total: batch.length });
    for (const row of batch) {
      if (!row.request || !here()) break;
      const key = keys.current.get(row.line) ?? crypto.randomUUID();
      keys.current.set(row.line, key);
      let outcome: Outcome;
      try {
        await invite.mutateAsync({ body: row.request, idempotencyKey: key });
        outcome = { sent: true };
      } catch (error) {
        if (!here()) break;
        const code = isApiError(error) ? error.serverCode : undefined;
        if (code !== undefined && ABOUT_THE_ROW.has(code)) {
          outcome = {
            sent: false,
            reason:
              code === 'validation_failed'
                ? tCommon(errorMessageKey(error))
                : t('bulk.problems.role'),
          };
        } else {
          // Not about this row (no connection, signed out, no longer allowed, asked to slow
          // down): the rest would fail the same way, so it waits instead.
          setStop(
            code === 'rate_limited'
              ? { kind: 'busy' }
              : { kind: 'error', message: tCommon(errorMessageKey(error)) },
          );
          break;
        }
      }
      if (!here()) break;
      const result = outcome;
      setOutcomes((current) => ({ ...current, [row.line]: result }));
      setProgress({ done: ++done, total: batch.length });
    }
    if (live.current.mounted) setProgress(null);
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
            : t('bulk.results.failed', { reason: outcome.reason });
        },
      },
      { id: 'line', header: t('bulk.columns.line'), value: (row) => row.line, align: 'end' },
    ],
    [t, outcomes],
  );

  const example = `name,email,role\nAsha Rao,asha.rao@example.org,${roles[0]?.name ?? ''}`;
  const summary = reading
    ? t('bulk.reading')
    : progress
      ? t('bulk.sending', { done: progress.done, total: progress.total })
      : !rows
        ? ''
        : sentCount + failedCount === 0
          ? [
              t('bulk.summary', { ready: waiting.length, total: rows.length }),
              problemCount > 0 ? t('bulk.summaryProblems', { count: problemCount }) : '',
            ]
          : [
              t('bulk.finished', { count: sentCount }),
              failedCount > 0 ? t('bulk.failed', { count: failedCount }) : '',
            ];

  return (
    <section aria-labelledby="staff-invite-bulk" className="flex flex-col gap-3">
      <h2 id="staff-invite-bulk" className="text-lg font-semibold">
        {t('bulk.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('bulk.description', { max: MAX_ROWS })}</p>
      <figure className="text-sm">
        <figcaption className="text-muted-foreground">{t('bulk.example')}</figcaption>
        <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2">{example}</pre>
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
          <Button
            variant="outline"
            disabled={sending}
            onClick={() => {
              forget();
              if (input.current) input.current.value = '';
            }}
          >
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
        {typeof summary === 'string' ? summary : summary.filter(Boolean).join(' ')}
      </p>
      {stop && (
        <p role="alert" className="text-sm text-destructive">
          {stop.kind === 'busy'
            ? t('bulk.stopped')
            : t('bulk.interrupted', { reason: stop.message })}
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
