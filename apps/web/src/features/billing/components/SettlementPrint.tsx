import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { Letterhead, useFormatters } from '@/tenancy';
import { cashOf, differenceText, netOf, totalsInOrder } from '../lib/register';
import type { RegisterSession } from '../types';

/**
 * "Print settlement": the day-end sheet of a session, for the handover: who, when, what each
 * payment mode took, the expected and counted cash, the difference and the note, with two lines
 * to sign. It holds money and a cashier's name, no patient, so no audit entry is needed.
 */
export function SettlementPrint({ session }: { session: RegisterSession }) {
  const { t } = useTranslation('billing');
  const [job, setJob] = useState(0);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setJob((now) => now + 1)}>
        {t('register.detail.print')}
      </Button>
      {job > 0 && (
        <PrintSheet key={job} onDone={() => setJob(0)}>
          <Sheet session={session} />
        </PrintSheet>
      )}
    </>
  );
}

function Sheet({ session }: { session: RegisterSession }) {
  const { t } = useTranslation('billing');
  const format = useFormatters();
  const { takenMinor, refundedMinor } = cashOf(session);
  const cell = 'border-b border-black/40 py-1 pr-3 text-left align-top';
  const amount = `${cell} text-right tabular-nums`;
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">{t('register.sheet.title')}</h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('register.sheet.cashier')}</dt>
        <dd>{session.openedByName}</dd>
        <dt className="font-medium">{t('register.sheet.opened')}</dt>
        <dd>{format.dateTime(session.openedAt)}</dd>
        {session.closedAt && (
          <>
            <dt className="font-medium">{t('register.sheet.closed')}</dt>
            <dd>{format.dateTime(session.closedAt)}</dd>
          </>
        )}
      </dl>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className={cell}>
              {t('register.totals.method')}
            </th>
            <th scope="col" className={amount}>
              {t('register.totals.taken')}
            </th>
            <th scope="col" className={amount}>
              {t('register.totals.refunded')}
            </th>
            <th scope="col" className={amount}>
              {t('register.totals.net')}
            </th>
          </tr>
        </thead>
        <tbody>
          {totalsInOrder(session).map((row) => (
            <tr key={row.method} className="break-inside-avoid">
              <th scope="row" className={`${cell} font-normal`}>
                {t(`payment.methods.${row.method}`)}
              </th>
              <td className={amount}>{format.money(row.paidMinor)}</td>
              <td className={amount}>{format.money(row.refundedMinor)}</td>
              <td className={amount}>{format.money(netOf(row))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-sm">
        {t('register.working.line', {
          opening: format.money(session.openingMinor),
          taken: format.money(takenMinor),
          refunded: format.money(refundedMinor),
          expected: format.money(session.expectedMinor),
        })}
      </p>
      <dl className="mt-4 ml-auto grid w-72 grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
        <dt>{t('register.current.expected')}</dt>
        <dd className="text-right">{format.money(session.expectedMinor)}</dd>
        {session.countedMinor !== undefined && (
          <>
            <dt className="font-semibold">{t('register.sheet.counted')}</dt>
            <dd className="text-right font-semibold">{format.money(session.countedMinor)}</dd>
          </>
        )}
      </dl>
      {session.differenceMinor !== undefined && (
        <p className="mt-2 font-medium">
          {differenceText(session.differenceMinor, t, format.money)}
        </p>
      )}
      {session.note && (
        <p className="mt-4">
          <span className="font-medium">{t('register.detail.note')}: </span>
          {session.note}
        </p>
      )}
      <div className="mt-12 grid grid-cols-2 gap-8 text-xs">
        <p className="border-t border-black pt-2">{t('register.sheet.signature')}</p>
        <p className="border-t border-black pt-2">{t('register.sheet.signatureReceiver')}</p>
      </div>
    </>
  );
}
