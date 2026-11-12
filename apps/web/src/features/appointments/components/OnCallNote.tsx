import { useTranslation } from 'react-i18next';
import { useOnCallNow } from '@/features/roster';
import { useFormatters } from '@/tenancy';

/**
 * Who is on call now, for the desk to see while booking. With `plain` the title is not a heading (a screen that has its own). With a department, only that department's. Shown only when the roster is switched
 * on and open to this person, and only when somebody is on call: it never gets in the way.
 */
export function OnCallNote({ departmentId, plain }: { departmentId?: string; plain?: boolean }) {
  const { t } = useTranslation('appointments');
  const format = useFormatters();
  const onCall = useOnCallNow(departmentId || undefined);
  const people = onCall.data ?? [];
  if (!onCall.available || people.length === 0) return null;
  return (
    <section aria-labelledby="book-on-call" className="rounded-md border p-3 text-sm">
      {plain ? (
        <p id="book-on-call" className="font-medium">
          {t('book.onCall.heading')}
        </p>
      ) : (
        <h2 id="book-on-call" className="font-medium">
          {t('book.onCall.heading')}
        </h2>
      )}
      <ul className="mt-1 flex flex-col gap-0.5">
        {people.map((one) => (
          <li key={`${one.userId}-${one.endsAt}`}>
            <span className="font-medium">{one.name}</span>
            {one.departmentName ? `, ${one.departmentName}` : ''}
            {' · '}
            {t('book.onCall.until', { time: format.dateTime(one.endsAt) })}
          </li>
        ))}
      </ul>
    </section>
  );
}
