import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useFormatters } from '@/tenancy';
import { RegisterFigures } from '../components/RegisterFigures';
import { SettlementPrint } from '../components/SettlementPrint';
import { useRegisterSession } from '../hooks/use-billing';

/**
 * One register session (`billing/register/sessions/:sessionId`, #118), for `cashRegister:read`:
 * what it took by payment mode, how its expected cash was worked out, the count, the difference
 * and the handover note. A settled session can be printed.
 */
export default function RegisterSessionDetail() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const { sessionId = '' } = useParams();
  const found = useRegisterSession(sessionId);
  const session = found.data;
  const missing = found.isError && isApiError(found.error) && found.error.status === 404;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('register.detail.heading')}</h1>
      <Link
        to="/billing/register/sessions"
        className="inline-flex w-fit items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
      >
        {t('register.detail.back')}
      </Link>
      {found.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : missing ? (
        <p role="alert">{t('register.detail.unavailable')}</p>
      ) : found.isError || !session ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {found.error ? tCommon(errorMessageKey(found.error)) : t('register.detail.unavailable')}
          </p>
          <Button type="button" variant="outline" onClick={() => void found.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="font-medium">{t('register.sheet.cashier')}</dt>
            <dd>{session.openedByName}</dd>
            <dt className="font-medium">{t('register.sheet.opened')}</dt>
            <dd>{format.dateTime(session.openedAt)}</dd>
            <dt className="font-medium">{t('register.detail.status')}</dt>
            <dd>
              {session.closedAt
                ? t('register.detail.settled', { time: format.dateTime(session.closedAt) })
                : t('register.detail.open')}
            </dd>
            <dt className="font-medium">{t('register.current.opening')}</dt>
            <dd>{format.money(session.openingMinor)}</dd>
            <dt className="font-medium">{t('register.current.expected')}</dt>
            <dd>{format.money(session.expectedMinor)}</dd>
            {session.countedMinor !== undefined && (
              <>
                <dt className="font-medium">{t('register.sheet.counted')}</dt>
                <dd>{format.money(session.countedMinor)}</dd>
              </>
            )}
            {session.closedAt && (
              <>
                <dt className="font-medium">{t('register.detail.note')}</dt>
                <dd>{session.note ?? t('register.detail.noNote')}</dd>
              </>
            )}
          </dl>
          <RegisterFigures session={session} />
          {session.closedAt && (
            <div>
              <SettlementPrint session={session} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
