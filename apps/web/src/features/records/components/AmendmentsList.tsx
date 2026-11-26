import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useFormatters } from '@/tenancy';
import { useCorrectionAmendments } from '../hooks/use-records';
import type { CorrectionAmendment, CorrectionTarget } from '../types';

/**
 * The amendments approved corrections added to a record (#1181), newest first: the text that was
 * asked for, the reason, who asked, who approved and when. Nothing here edits the record; an
 * amendment sits beside it. With a `target` only that visit or document's are read; without,
 * every one of the patient's, each naming its record. `quiet` shows nothing while there is none
 * (the visit's panel), so a record with no amendment looks as it always did.
 */
export function AmendmentsList({
  patientId,
  target,
  label,
  quiet = false,
}: {
  patientId: string;
  target?: { kind: CorrectionTarget; id?: string };
  label: string;
  quiet?: boolean;
}) {
  const { t } = useTranslation('records');
  const { t: tCommon } = useTranslation();
  const amendments = useCorrectionAmendments(patientId, target);
  const rows = useMemo(
    () => amendments.data?.pages.flatMap((page) => page.items) ?? [],
    [amendments.data],
  );
  if (amendments.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {tCommon(errorMessageKey(amendments.error))}
      </p>
    );
  }
  if (amendments.isPending) {
    return quiet ? null : (
      <p role="status" className="text-sm text-muted-foreground">
        {t('amendments.loading')}
      </p>
    );
  }
  if (rows.length === 0) {
    return quiet ? null : <p className="text-sm text-muted-foreground">{t('amendments.empty')}</p>;
  }
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">{label}</h2>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <AmendmentCard key={row.id} amendment={row} showTarget={!target} />
        ))}
      </ul>
      {amendments.hasNextPage && (
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void amendments.fetchNextPage()}
            aria-disabled={amendments.isFetchingNextPage}
          >
            {t('amendments.more')}
          </Button>
        </div>
      )}
    </section>
  );
}

function AmendmentCard({
  amendment,
  showTarget,
}: {
  amendment: CorrectionAmendment;
  showTarget: boolean;
}) {
  const { t } = useTranslation('records');
  const format = useFormatters();
  const someone = t('amendments.someone');
  return (
    <li className="rounded-lg border border-border bg-card p-3 text-sm">
      {showTarget && (
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          {t(`amendments.target.${amendment.targetKind}`)}
        </p>
      )}
      <p className="font-medium">{amendment.proposed}</p>
      <p className="text-muted-foreground">
        {t('amendments.reason', { reason: amendment.reason })}
      </p>
      <p className="text-muted-foreground">
        {t('amendments.who', {
          requester: amendment.requestedByName ?? someone,
          approver: amendment.approvedByName ?? someone,
          when: format.dateTime(amendment.appliedAt),
        })}
      </p>
      {amendment.outcome === 'target_unavailable' && (
        <p className="text-muted-foreground">{t('amendments.unavailable')}</p>
      )}
    </li>
  );
}
