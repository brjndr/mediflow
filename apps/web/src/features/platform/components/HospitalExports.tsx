import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { Form, TextField, useZodForm } from '@/shared/ui/form';
import { StatusBadge, type StatusTone } from '@/shared/ui/status-badge';
import { useFormatters } from '@/tenancy/use-formatters';
import { useExportList, useEmailExportLink, useStartExport } from '../hooks/use-hospitals';
import { exportLinkRequestSchema } from '../schemas';
import type { Hospital, HospitalExport } from '../types';

const LINK_FORM = 'export-link-form';

/** Reasons the API gives for refusing, with their own words. */
const REFUSALS = new Set([
  'export_in_progress',
  'hospital_not_offboarding',
  'not_a_hospital_admin',
  'export_not_ready',
]);

const TONE: Record<HospitalExport['status'], StatusTone> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
};

/**
 * The offboarding exports of a hospital: where each one stands, how often it was downloaded, a new
 * export, and a download link emailed to one admin of the hospital (the hospital is closed, so the
 * link is the only way in). The link is made and sent by a job: it never reaches this screen.
 */
export function HospitalExports({ hospital }: { hospital: Hospital }) {
  const { t } = useTranslation();
  const format = useFormatters();
  const exports = useExportList(hospital.id);
  const start = useStartExport(hospital.id);
  const issue = useEmailExportLink(hospital.id);
  const [target, setTarget] = useState<HospitalExport | null>(null);
  const [message, setMessage] = useState('');
  const [refused, setRefused] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  const form = useZodForm(exportLinkRequestSchema, { adminUserId: '' });
  const offboarding = hospital.status === 'offboarding';

  const say = (text: string) => {
    setMessage(text);
    queueMicrotask(() => focusIfLost(statusLine.current));
  };

  const refusal = (error: unknown) =>
    isApiError(error) && error.serverCode !== undefined && REFUSALS.has(error.serverCode)
      ? t(`platform.exports.refused.${error.serverCode}`)
      : t(errorMessageKey(error));

  const begin = () => {
    if (start.isPending) return;
    setMessage('');
    setRefused('');
    start.mutate(undefined, {
      onSuccess: () => say(t('platform.exports.started')),
      onError: (error) => setRefused(refusal(error)),
    });
  };

  const closeDialog = () => {
    if (issue.isPending) return;
    setTarget(null);
    setRefused('');
    form.reset();
  };

  const makeLink = (values: { adminUserId: string }) => {
    if (issue.isPending || target === null) return;
    issue.mutate(
      { exportId: target.id, adminUserId: values.adminUserId },
      {
        onSuccess: (sent) => {
          setTarget(null);
          setRefused('');
          form.reset();
          say(t('platform.exports.linkSent', { days: sent.expiresInDays }));
        },
        onError: (error) => setRefused(refusal(error)),
      },
    );
  };

  const columns = useMemo<GridColumn<HospitalExport>[]>(
    () => [
      {
        id: 'requested',
        header: t('platform.exports.columns.requested'),
        value: (row) => format.dateTime(row.requestedAt),
      },
      {
        id: 'status',
        header: t('platform.exports.columns.status'),
        value: (row) => t(`platform.exports.status.${row.status}`),
        render: (row, text) => <StatusBadge tone={TONE[row.status]} label={text} />,
      },
      {
        id: 'size',
        header: t('platform.exports.columns.size'),
        value: (row) => {
          if (row.failure !== null) {
            return t(`platform.exports.reason.${row.failure}`, { defaultValue: row.failure });
          }
          if (row.status !== 'succeeded' || row.fileBytes === null) {
            return t('platform.exports.none');
          }
          return t('platform.exports.size', {
            size: new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
              row.fileBytes / 1_048_576,
            ),
            tables: row.tableCount ?? 0,
            rows: row.rowCount ?? 0,
            files: row.fileCount ?? 0,
          });
        },
      },
      {
        id: 'downloads',
        header: t('platform.exports.columns.downloads'),
        value: (row) =>
          row.downloadCount === 0
            ? t('platform.exports.neverDownloaded')
            : t('platform.exports.downloads', {
                count: row.downloadCount,
                first: format.dateTime(row.firstDownloadedAt ?? row.requestedAt),
                last: format.dateTime(row.lastDownloadedAt ?? row.requestedAt),
              }),
      },
    ],
    // `format` is rebuilt on each render; its inputs do not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  return (
    <section aria-labelledby="hospital-exports" className="flex flex-col gap-3">
      <h2 id="hospital-exports" className="text-lg font-semibold">
        {t('platform.exports.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('platform.exports.hint')}</p>

      {offboarding && (
        <div>
          <Button variant="outline" onClick={begin} aria-disabled={start.isPending || undefined}>
            {t('platform.exports.start')}
          </Button>
        </div>
      )}
      {refused !== '' && target === null && (
        <p role="alert" className="text-sm text-destructive">
          {refused}
        </p>
      )}

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message}
      </p>

      <DataGrid
        label={t('platform.exports.gridLabel')}
        columns={columns}
        rows={exports.data ?? []}
        rowId={(row) => row.id}
        rowLabel={(row) => format.dateTime(row.requestedAt)}
        status={exports.isPending ? 'loading' : exports.isError ? 'error' : 'ready'}
        errorMessage={exports.isError ? t(errorMessageKey(exports.error)) : undefined}
        onRetry={() => void exports.refetch()}
        emptyMessage={t('platform.exports.empty')}
        actions={
          offboarding
            ? [
                {
                  id: 'link',
                  label: t('platform.exports.issue'),
                  onSelect: (row) => {
                    if (row.status !== 'succeeded') return;
                    setMessage('');
                    setRefused('');
                    setTarget(row);
                  },
                  disabled: (row) => row.status !== 'succeeded',
                },
              ]
            : []
        }
      />

      <ConfirmDialog
        open={target !== null}
        onClose={closeDialog}
        title={t('platform.exports.dialogTitle')}
        description={t('platform.exports.dialogDescription')}
        cancelLabel={t('platform.status.cancel')}
        confirmLabel={t('platform.exports.dialogConfirm')}
        confirmForm={LINK_FORM}
        pending={issue.isPending}
      >
        <Form form={form} id={LINK_FORM} onSubmit={makeLink} className="gap-3">
          <TextField
            name="adminUserId"
            label={t('platform.exports.adminId')}
            hint={t('platform.exports.adminIdHint')}
            autoComplete="off"
            required
            data-autofocus
          />
        </Form>
        {refused !== '' && target !== null && (
          <p role="alert" className="text-sm text-destructive">
            {refused}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}
