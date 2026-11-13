import { TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePermission } from '@/access';
import type { SlotProps } from '@/registry';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { StatusBadge } from '@/shared/ui/status-badge';
import { useFormatters } from '@/tenancy';
import { useCoverageSplit, useSaveSplit } from '../hooks/use-split';
import { ClaimPacketDialog } from './ClaimDialogs';
import { splitReconciles } from '../split';
import type { ClaimDetail, CoverageSplitLine } from '../types';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * How the visit's bill divides between the patient and the payer (`invoice.builder.panels`,
 * IN-03, #183), for `policy:read`: every charge of the ledger at the payer's agreed rate, what
 * the payer pays, what the patient pays and why. The figures are the server's; the panel checks
 * that they add up to the ledger and says so, or says they do not. `policy:manage` keeps the split
 * as the one the bills are made from. Shows nothing for a patient without an active policy.
 */
export default function SplitPanel({ context }: SlotProps) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canRead = usePermission('policy:read');
  const canSave = usePermission('policy:manage');
  const encounterId =
    typeof context?.encounterId === 'string' && ID.test(context.encounterId)
      ? context.encounterId
      : '';
  const split = useCoverageSplit(encounterId, canRead);
  const save = useSaveSplit(encounterId);
  const [saved, setSaved] = useState(false);
  const canClaim = usePermission('claim:manage');
  const canOpenClaim = usePermission('claim:read');
  const [packet, setPacket] = useState(false);
  const [claim, setClaim] = useState<ClaimDetail>();

  const columns = useMemo<GridColumn<CoverageSplitLine>[]>(
    () => [
      { id: 'what', header: t('split.columns.what'), value: (row) => row.description },
      {
        id: 'ledger',
        header: t('split.columns.ledger'),
        value: (row) => format.money(row.ledgerMinor),
        align: 'end',
      },
      {
        id: 'rated',
        header: t('split.columns.rated'),
        value: (row) => format.money(row.ratedMinor),
        align: 'end',
      },
      {
        id: 'payer',
        header: t('split.columns.payer'),
        value: (row) => format.money(row.payerMinor),
        align: 'end',
      },
      {
        id: 'patient',
        header: t('split.columns.patient'),
        value: (row) => format.money(row.patientMinor),
        align: 'end',
      },
      {
        id: 'reason',
        header: t('split.columns.reason'),
        value: (row) => t(`split.reason.${row.reason}`),
      },
    ],
    [t, format],
  );

  // No policy (404) or nothing yet: nothing to say. Any other failure is shown.
  if (!canRead || encounterId === '' || split.isPending) return null;
  if (split.isError && isApiError(split.error) && split.error.status === 404) return null;

  if (split.isError) {
    return (
      <section
        aria-labelledby="split-heading"
        className="flex flex-col gap-2 rounded-md border p-3"
      >
        <h2 id="split-heading" className="text-lg font-semibold">
          {t('split.heading')}
        </h2>
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(split.error))}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void split.refetch()}>
          {tCommon('grid.retry')}
        </Button>
      </section>
    );
  }
  const data = split.data;
  const reconciles = splitReconciles(data);

  return (
    <section aria-labelledby="split-heading" className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="split-heading" className="text-lg font-semibold">
          {t('split.heading')}
        </h2>
        {canSave && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={save.isPending || undefined}
            onClick={() => {
              if (save.isPending) return;
              setSaved(false);
              save.mutate(undefined, { onSuccess: () => setSaved(true) });
            }}
          >
            {save.isPending ? t('split.saving') : t('split.save')}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {t('split.terms', {
          payer: data.payerName,
          plan: data.planName,
          percent: data.copayPercent,
        })}{' '}
        {data.agreementName !== undefined && t('split.agreement', { name: data.agreementName })}
      </p>
      {/* Always on the page, so a save or a refusal is announced. */}
      <p role="status" className={saved || save.isError ? 'text-sm' : 'sr-only'}>
        {saved ? t('split.saved') : save.isError ? tCommon(errorMessageKey(save.error)) : ''}
      </p>
      {data.stale && (
        <p role="alert" className="flex items-center gap-2 text-sm">
          <TriangleAlert aria-hidden="true" className="size-4" />
          {t('split.stale')}
        </p>
      )}
      <DataGrid
        label={t('split.heading')}
        columns={columns}
        rows={data.lines}
        rowId={(row) => row.chargeId}
        rowLabel={(row) => row.description}
        status="ready"
        emptyMessage={t('split.empty')}
      />
      <dl
        className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm"
        aria-label={t('split.totals')}
      >
        <dt>{t('split.ledger')}</dt>
        <dd className="text-end" data-testid="split-ledger">
          {format.money(data.ledgerMinor)}
        </dd>
        <dt>{t('split.adjustment')}</dt>
        <dd className="text-end" data-testid="split-adjustment">
          {format.money(data.rateAdjustmentMinor)}
        </dd>
        <dt className="font-medium">{t('split.payer', { name: data.payerName })}</dt>
        <dd className="text-end font-medium" data-testid="split-payer">
          {format.money(data.payerMinor)}
        </dd>
        <dt className="font-medium">{t('split.patient')}</dt>
        <dd className="text-end font-medium" data-testid="split-patient">
          {format.money(data.patientMinor)}
        </dd>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge
          tone={reconciles ? 'success' : 'danger'}
          label={reconciles ? t('split.reconciled') : t('split.notReconciled')}
        />
        {canClaim && data.payerMinor > 0 && claim === undefined && (
          <Button type="button" variant="outline" size="sm" onClick={() => setPacket(true)}>
            {t('claims.packet.button')}
          </Button>
        )}
      </div>
      {/* Always on the page, so the new claim is announced. */}
      <p role="status" className={claim ? 'text-sm' : 'sr-only'}>
        {claim ? t('claims.packet.saved', { number: claim.number }) : ''}{' '}
        {claim && canOpenClaim && (
          <Link to={`/claims/${claim.id}`} className="font-medium underline">
            {t('claims.packet.open')}
          </Link>
        )}
      </p>
      {packet && (
        <ClaimPacketDialog
          encounterId={encounterId}
          payerMinor={data.payerMinor}
          onClose={() => setPacket(false)}
          onCreated={(made) => {
            setPacket(false);
            setClaim(made);
          }}
        />
      )}
    </section>
  );
}
