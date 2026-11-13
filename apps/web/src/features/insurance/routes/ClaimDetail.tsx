import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { useFormatters } from '@/tenancy';
import { ClaimActionDialog } from '../components/ClaimDialogs';
import { ClaimPatient } from '../components/ClaimPatient';
import { ClaimStatusBadge } from '../components/ClaimStatusBadge';
import { actionPermission } from '../claims';
import { useClaim } from '../hooks/use-claims';
import type { ClaimActionKind } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function ClaimDetail() {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const params = useParams();
  const claimId = params.claimId !== undefined && ID.test(params.claimId) ? params.claimId : '';
  const claim = useClaim(claimId);
  const canManage = usePermission('claim:manage');
  const canWriteOff = usePermission('claim:writeoff');
  const [acting, setActing] = useState<ClaimActionKind | null>(null);
  const [done, setDone] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(status.current);
  }, [done]);

  if (claim.isPending && claimId !== '') return <PageSkeleton label={t('claims.detail.loading')} />;
  if (claim.data === undefined) {
    const missing = claimId === '' || (isApiError(claim.error) && claim.error.code === 'not_found');
    return (
      <SystemPage
        alert={!missing}
        title={missing ? t('claims.detail.notFound') : t('notFound.errorTitle')}
        description={
          missing ? t('claims.detail.notFoundBody') : tCommon(errorMessageKey(claim.error))
        }
        actions={
          <Link to="/claims" className={link}>
            {t('claims.backToList')}
          </Link>
        }
      />
    );
  }
  const record = claim.data;
  const may = (action: ClaimActionKind) =>
    actionPermission(action) === 'claim:writeoff' ? canWriteOff : canManage;
  const offered = record.allowedActions.filter(may);

  const row = (label: string, value: string) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end sm:text-start">{value}</dd>
    </>
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6">
      <div className="space-y-2">
        <Link to="/claims" className={link}>
          {t('claims.backToList')}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('claims.detail.heading', { number: record.number })}
          </h1>
          <ClaimStatusBadge status={record.status} />
        </div>
        {/* Always on the page, so a move is announced. */}
        <p ref={status} role="status" tabIndex={-1} className={done ? 'text-sm' : 'sr-only'}>
          {done}
        </p>
      </div>

      {record.openQuery !== undefined && (
        <p role="note" className="rounded-md border p-3 text-sm">
          <span className="font-medium">{t('claims.detail.openQuery')}</span> {record.openQuery}
        </p>
      )}

      <section aria-labelledby="claim-summary" className="flex flex-col gap-2">
        <h2 id="claim-summary" className="text-lg font-semibold">
          {t('claims.detail.summary')}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted-foreground">{t('claims.detail.patient')}</dt>
          <dd className="text-end sm:text-start">
            <ClaimPatient patientId={record.patientId} />
          </dd>
          {row(t('claims.detail.payer'), record.payerName)}
          {row(t('claims.detail.policy'), record.policyNumber)}
          {row(t('claims.detail.claimed'), format.money(record.claimedMinor))}
          {row(
            t('claims.detail.approved'),
            record.approvedMinor === undefined ? '-' : format.money(record.approvedMinor),
          )}
          {row(t('claims.detail.received'), format.money(record.receivedMinor))}
          {row(t('claims.detail.writtenOff'), format.money(record.writtenOffMinor))}
          {row(t('claims.detail.outstanding'), format.money(record.outstandingMinor))}
          {row(t('claims.detail.reference'), record.referenceNumber ?? t('claims.detail.notGiven'))}
        </dl>
      </section>

      <section aria-labelledby="claim-packet" className="flex flex-col gap-2">
        <h2 id="claim-packet" className="text-lg font-semibold">
          {t('claims.detail.packet')}
        </h2>
        {record.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('claims.detail.packetEmpty')}</p>
        ) : (
          <ul className="list-disc ps-5 text-sm">
            {record.documents.map((name, index) => (
              <li key={`${index}-${name}`}>{name}</li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted-foreground">{t('claims.detail.packetHint')}</p>
      </section>

      <section aria-labelledby="claim-actions" className="flex flex-col gap-2">
        <h2 id="claim-actions" className="text-lg font-semibold">
          {t('claims.detail.actions')}
        </h2>
        {record.allowedActions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('claims.detail.noActions')}</p>
        ) : offered.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('claims.detail.noRights')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {offered.map((action) => (
              <Button
                key={action}
                type="button"
                variant={action === 'write_off' || action === 'cancel' ? 'outline' : 'default'}
                onClick={() => {
                  setDone('');
                  setActing(action);
                }}
              >
                {t(`claims.action.${action}`)}
              </Button>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="claim-history" className="flex flex-col gap-2">
        <h2 id="claim-history" className="text-lg font-semibold">
          {t('claims.detail.history')}
        </h2>
        <ol className="flex flex-col gap-2 text-sm">
          {record.events.map((event, index) => (
            <li key={`${event.at}-${index}`} className="rounded-md border p-2">
              <p className="font-medium">
                {t(`claims.event.${event.action}`)}
                {event.amountMinor !== undefined && `: ${format.money(event.amountMinor)}`}
              </p>
              <p className="text-muted-foreground">{format.dateTime(event.at)}</p>
              {event.note !== undefined && <p>{event.note}</p>}
            </li>
          ))}
        </ol>
      </section>

      {acting !== null && (
        <ClaimActionDialog
          claim={record}
          action={acting}
          onClose={() => setActing(null)}
          onDone={(next) => {
            setActing(null);
            setDone(t('claims.detail.saved', { state: t(`claims.status.${next.status}`) }));
          }}
        />
      )}
    </div>
  );
}
