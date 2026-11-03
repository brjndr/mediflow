import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { cn } from '@/shared/lib/utils';
import { useFormatters } from '@/tenancy';
import { CloseRegisterForm } from '../components/CloseRegisterForm';
import { OpenRegisterForm } from '../components/OpenRegisterForm';
import { RegisterFigures } from '../components/RegisterFigures';
import { SettlementPrint } from '../components/SettlementPrint';
import { useCloseRegister, useCurrentRegister, useOpenRegister } from '../hooks/use-billing';
import { useFocusWhenFormGoes } from '../lib/panel-helpers';
import { differenceText } from '../lib/register';
import type { RegisterSession } from '../types';

/**
 * The caller's own cash drawer (`billing/register`, #118), for `cashRegister:manage`: open it
 * with the cash in it, see what it has taken by payment mode and the cash it should hold, and
 * settle it at the end of the shift with the cash counted. A settled drawer shows its settlement,
 * which can be printed for the handover, and a new one can be opened.
 */
export default function Register() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const current = useCurrentRegister();
  const open = useOpenRegister();
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  // The settlement just made, kept to show and print once the drawer is no longer the current one.
  const [settled, setSettled] = useState<RegisterSession | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const session = current.data ?? null;

  // A form that goes after a save hands focus to the status line, which says what happened.
  useFocusWhenFormGoes(current.isSuccess && session === null, message !== null, status);
  useFocusWhenFormGoes(session !== null, message !== null, status);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('register.heading')}</h1>
        <p className="text-muted-foreground">{t('register.description')}</p>
        <Can permission="cashRegister:read">
          <Link
            to="/billing/register/sessions"
            className="inline-flex items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
          >
            {t('register.sessionsLink')}
          </Link>
        </Can>
      </div>

      {/* Always on the page, so a saved or refused action is announced. */}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className={cn(
          'text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden',
          message?.failed && 'text-destructive',
        )}
      >
        {message?.text}
      </p>

      {current.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : current.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(current.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void current.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : session ? (
        <OpenDrawer
          session={session}
          onClosed={(done) => {
            setSettled(done);
            setMessage({
              text: t('register.close.done', {
                difference: differenceText(done.differenceMinor ?? 0, t, format.money),
              }),
              failed: false,
            });
          }}
          onRefused={(text) => setMessage({ text, failed: true })}
        />
      ) : (
        <>
          {settled && (
            <section aria-labelledby="settled-heading" className="flex flex-col gap-3">
              <h2 id="settled-heading" className="text-lg font-semibold">
                {t('register.detail.settled', { time: format.dateTime(settled.closedAt ?? '') })}
              </h2>
              <RegisterFigures session={settled} />
              <div>
                <SettlementPrint session={settled} />
              </div>
            </section>
          )}
          <p className="text-sm text-muted-foreground">{t('register.noneOpen')}</p>
          <OpenRegisterForm
            open={open}
            onOpened={(openingMinor) => {
              setSettled(null);
              setMessage({
                text: t('register.open.done', { amount: format.money(openingMinor) }),
                failed: false,
              });
            }}
            onRefused={(text) => setMessage({ text, failed: true })}
          />
        </>
      )}
    </div>
  );
}

function OpenDrawer({
  session,
  onClosed,
  onRefused,
}: {
  session: RegisterSession;
  onClosed: (settled: RegisterSession) => void;
  onRefused: (text: string) => void;
}) {
  const { t } = useTranslation('billing');
  const format = useFormatters();
  const close = useCloseRegister(session.id);
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="drawer-heading" className="flex flex-col gap-1">
        <h2 id="drawer-heading" className="text-lg font-semibold">
          {t('register.current.heading', { time: format.dateTime(session.openedAt) })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('register.current.openedBy', { name: session.openedByName })}
        </p>
        <p className="text-sm">
          {t('register.current.opening')}: {format.money(session.openingMinor)}
        </p>
        <p className="text-sm font-medium" data-testid="expected">
          {t('register.current.expected')}: {format.money(session.expectedMinor)}
        </p>
      </section>
      <RegisterFigures session={session} />
      <CloseRegisterForm close={close} onClosed={onClosed} onRefused={onRefused} />
    </div>
  );
}
