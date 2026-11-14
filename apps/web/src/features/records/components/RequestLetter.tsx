import { useTranslation } from 'react-i18next';
import { useSession } from '@/app/session';
import { Letterhead, useFormatters } from '@/tenancy';
import type { RecordRequest } from '../types';

/**
 * The covering letter for a fulfilled record request (#571): who asked, for whom, why, and who
 * closed it and when. It carries no clinical content: the record itself is released by hand.
 * It is drawn from the row already on the screen, into a `PrintSheet`.
 */
export function RequestLetter({ request }: { request: RecordRequest }) {
  const { t } = useTranslation('records');
  const format = useFormatters();
  const printedBy = useSession()?.user.name ?? '';
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">{t('requests.letter.title')}</h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('requests.letter.patient')}</dt>
        <dd>{`${request.patientName} (${request.patientMrn})`}</dd>
        <dt className="font-medium">{t('requests.letter.requester')}</dt>
        <dd>{`${request.requesterName} (${t(`requester.${request.requesterKind}`)})`}</dd>
        <dt className="font-medium">{t('requests.letter.purpose')}</dt>
        <dd>{request.purpose}</dd>
        <dt className="font-medium">{t('requests.letter.requested')}</dt>
        <dd>{format.calendarDate(request.requestedOn)}</dd>
        {request.closedAt && (
          <>
            <dt className="font-medium">{t('requests.letter.fulfilled')}</dt>
            <dd>{format.date(request.closedAt)}</dd>
          </>
        )}
        {request.closedByName && (
          <>
            <dt className="font-medium">{t('requests.letter.fulfilledBy')}</dt>
            <dd>{request.closedByName}</dd>
          </>
        )}
        {request.note && (
          <>
            <dt className="font-medium">{t('requests.letter.note')}</dt>
            <dd>{request.note}</dd>
          </>
        )}
      </dl>
      <p>{t('requests.letter.body')}</p>
      <p className="mt-6 text-xs">{printedBy}</p>
    </>
  );
}
