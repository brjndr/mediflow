import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { StatusBadge } from '@/shared/ui/status-badge';
import { useFormatters } from '@/tenancy';
import { limitLevel, limitUsedPercent } from '../coverage-schemas';

/**
 * What a visit has been charged against the limit the payer approved: the two amounts, what is
 * left, a bar and a word for where it stands (colour is never the only signal). Near the limit
 * and past it are said in a message the screen reader hears when it appears.
 */
export function LimitMeter({
  billedMinor,
  approvedMinor,
}: {
  billedMinor: number;
  approvedMinor: number;
}) {
  const { t } = useTranslation('insurance');
  const format = useFormatters();
  const level = limitLevel(billedMinor, approvedMinor);
  const used = limitUsedPercent(billedMinor, approvedMinor) ?? 100;
  const left = Math.max(approvedMinor - billedMinor, 0);
  const over = Math.max(billedMinor - approvedMinor, 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>{t('limit.approved', { amount: format.money(approvedMinor) })}</span>
        <span>{t('limit.billed', { amount: format.money(billedMinor) })}</span>
        <span className="font-medium">
          {over > 0
            ? t('limit.over', { amount: format.money(over) })
            : t('limit.left', { amount: format.money(left) })}
        </span>
        <StatusBadge
          tone={level === 'ok' ? 'success' : level === 'near' ? 'warning' : 'danger'}
          label={t(`limit.level.${level}`, { percent: Math.min(used, 999) })}
        />
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn(
            'h-full rounded-full',
            level === 'ok' ? 'bg-success' : level === 'near' ? 'bg-warning' : 'bg-destructive',
          )}
          style={{ width: `${Math.min(used, 100)}%` }}
        />
      </div>
      {/* Always on the page so a change from ok to near is announced. */}
      <p
        role={level === 'reached' ? 'alert' : 'status'}
        className={cn('flex items-center gap-1.5 text-sm', level === 'ok' && 'sr-only')}
      >
        {level !== 'ok' && <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />}
        {level === 'ok' ? '' : t(`limit.warning.${level}`)}
      </p>
    </div>
  );
}
