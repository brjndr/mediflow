import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useTenant, useFormatters } from '@/tenancy';
import { useBedHistory } from '../hooks/use-admissions';
import { stayDays } from '../schemas';
import type { Admission } from '../types';

/**
 * Every bed one admission has been in, oldest first, with the days each is charged for and a
 * note where the bed's category (so its day price) differs from the one before.
 */
export function BedHistoryPanel({
  admission,
  onBack,
}: {
  admission: Admission;
  onBack: () => void;
}) {
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timeZone = useTenant()?.timezone ?? 'UTC';
  const history = useBedHistory(admission.id);
  const stays = history.data ?? [];

  return (
    <section
      aria-labelledby="bed-history-heading"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2
        id="bed-history-heading"
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('history.heading', { patient: admission.patientName })}
      </h2>
      {history.isPending && <p role="status">{t('history.loading')}</p>}
      {history.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(history.error))}
        </p>
      )}
      {history.isSuccess && stays.length === 0 && (
        <p className="text-muted-foreground">{t('history.empty')}</p>
      )}
      {stays.length > 0 && (
        <ol aria-label={t('history.list')} className="flex flex-col gap-2">
          {stays.map((stay, index) => {
            const before = stays[index - 1];
            const days = stayDays(stay, new Date(), timeZone);
            return (
              <li key={stay.assignmentId} className="rounded-md border p-3 text-sm">
                <p className="font-medium">
                  {t('bedOf', { number: stay.bedNumber, ward: stay.wardName })}
                </p>
                <p>
                  {format.dateTime(stay.assignedAt)}
                  {' - '}
                  {stay.releasedAt ? format.dateTime(stay.releasedAt) : t('history.now')}
                </p>
                {stay.dayPriceMinor !== undefined && (
                  <p>
                    {t('history.price', {
                      price: format.money(stay.dayPriceMinor),
                      amount: format.money(stay.dayPriceMinor * days),
                    })}
                  </p>
                )}
                {stay.moveReason && (
                  <p>
                    {t('history.arrived', { reason: t(`moveReasons.${stay.moveReason}`) })}
                    {stay.moveNote ? `: ${stay.moveNote}` : ''}
                  </p>
                )}
                <p>
                  {t('history.days', { count: days })}
                  {stay.releaseReason ? `, ${t(`history.reasons.${stay.releaseReason}`)}` : ''}
                </p>
                {before && before.bedCategoryId !== stay.bedCategoryId && (
                  <p className="text-muted-foreground">{t('history.categoryChanged')}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div>
        <Button type="button" variant="outline" onClick={onBack}>
          {t('history.close')}
        </Button>
      </div>
    </section>
  );
}
