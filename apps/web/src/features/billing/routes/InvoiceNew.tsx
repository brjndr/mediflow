import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { useEncounter } from '@/features/clinical';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { InvoiceBuilder } from '../components/InvoiceBuilder';
import { useVisitInvoices } from '../hooks/use-billing';

/** An id from the address, or empty when it is not one. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A new invoice (`billing/new?encounterId=`, #109), for `invoice:create` and `charge:read`: the
 * visit's pending charges and lines typed in, saved as a draft and issued. A draft the visit
 * already has is offered to continue, for whoever may read invoices. The address holds the
 * visit's id and nothing about the patient.
 */
export default function InvoiceNew() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const raw = useSearchParams()[0].get('encounterId') ?? '';
  const encounterId = ID.test(raw) ? raw : '';
  const encounter = useEncounter(encounterId);
  const missing =
    encounterId === '' ||
    (isApiError(encounter.error) &&
      (encounter.error.status === 404 || encounter.error.status === 403));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('new.heading')}</h1>
      {missing ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm">
            {t('new.unavailable')}
          </p>
          <Button asChild variant="outline">
            <Link to="/encounters">{t('new.back')}</Link>
          </Button>
        </div>
      ) : encounter.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : encounter.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(encounter.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void encounter.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-lg font-medium">
            {t('new.patient', {
              name: encounter.data.patientName,
              mrn: encounter.data.patientMrn,
            })}
          </p>
          <ExistingDrafts encounterId={encounterId} />
          <InvoiceBuilder encounterId={encounterId} />
        </>
      )}
    </div>
  );
}

/** The visit's unfinished drafts, to continue instead of making a second bill of the same work. */
function ExistingDrafts({ encounterId }: { encounterId: string }) {
  const { t } = useTranslation('billing');
  const canRead = usePermission('invoice:read');
  const invoices = useVisitInvoices(encounterId, { enabled: canRead });
  const drafts = invoices.data?.pages
    .flatMap((page) => page.items)
    .filter((i) => i.status === 'draft');
  if (!canRead || !drafts || drafts.length === 0) return null;
  return (
    <div role="note" className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm">{t('new.hasDraft', { count: drafts.length })}</p>
      <ul className="flex flex-wrap gap-2">
        {drafts.map((draft) => (
          <li key={draft.id}>
            <Button asChild variant="outline" size="sm">
              <Link to={`/billing/invoices/${draft.id}`}>{t('new.continueDraft')}</Link>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
