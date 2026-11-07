import { useTranslation } from 'react-i18next';
import { useFormatters } from '@/tenancy';
import { useOnCallNow } from '../hooks/use-roster';

/** The people on call at this moment, with the department and when they come off. */
export function OnCallPanel() {
  const { t } = useTranslation('roster');
  const format = useFormatters();
  const onCall = useOnCallNow();
  const people = onCall.data ?? [];
  return (
    <section aria-labelledby="roster-on-call" className="rounded-md border p-4">
      <h2 id="roster-on-call" className="text-base font-semibold">
        {t('onCall.heading')}
      </h2>
      {onCall.isPending ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('onCall.loading')}</p>
      ) : onCall.isError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t('onCall.error')}
        </p>
      ) : people.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('onCall.none')}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {people.map((one) => (
            <li key={`${one.userId}-${one.endsAt}`}>
              <span className="font-medium">{one.name}</span>
              {one.departmentName ? `, ${one.departmentName}` : ''}
              {' · '}
              {t('onCall.until', { time: format.dateTime(one.endsAt) })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
