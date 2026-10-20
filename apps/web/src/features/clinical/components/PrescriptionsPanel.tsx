import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { cn } from '@/shared/lib/utils';
import { useFormatters } from '@/tenancy';
import { usePrescriptions } from '../hooks/use-clinical';
import { linesInOrder } from '../schemas';
import type { Encounter, Order, Prescription } from '../types';
import { PrescriptionForm } from './PrescriptionForm';

type Writing = { kind: 'new' } | { kind: 'revise'; prescription: Prescription };

/**
 * The encounter's prescriptions, for `prescription:read`, oldest first, each with its lines in
 * the order written. A replaced one stays, muted, and says which replaced it and why.
 * `prescription:create` writes one while the encounter is open, and revises one not yet replaced:
 * a revision is a new prescription, and the server cancels the old one's lines not started.
 */
export function PrescriptionsPanel({ encounter }: { encounter: Encounter }) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const headingId = useId();
  const canWrite = usePermission('prescription:create');
  const prescriptions = usePrescriptions(encounter.id);
  const box = useRef<HTMLElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const [writing, setWriting] = useState<Writing | null>(null);
  usePanelFocus(
    writing ? (writing.kind === 'new' ? 'new' : writing.prescription.id) : null,
    box,
    status,
  );
  const items = useMemo(
    () => prescriptions.data?.pages.flatMap((page) => page.items) ?? [],
    [prescriptions.data],
  );
  const byId = useMemo(() => new Map(items.map((each) => [each.id, each])), [items]);
  // Every medication order of the encounter still in effect, for the duplicate check.
  const standing = useMemo(
    () => items.flatMap((each) => each.lines).filter((line) => line.status !== 'cancelled'),
    [items],
  );
  const open = encounter.status === 'open';
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  return (
    <section ref={box} aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('prescriptions.heading')}
      </h2>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {message.text}
      </p>
      {prescriptions.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : prescriptions.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(prescriptions.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void prescriptions.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('prescriptions.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {items.map((prescription) => (
            <li key={prescription.id}>
              <PrescriptionView
                prescription={prescription}
                replaces={prescription.replacesId ? byId.get(prescription.replacesId) : undefined}
                replacedBy={
                  prescription.replacedById ? byId.get(prescription.replacedById) : undefined
                }
                onRevise={
                  canWrite && open && !prescription.replacedById && writing === null
                    ? () => setWriting({ kind: 'revise', prescription })
                    : undefined
                }
              />
            </li>
          ))}
        </ol>
      )}
      {prescriptions.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          aria-disabled={prescriptions.isFetchingNextPage || undefined}
          onClick={() => {
            if (!prescriptions.isFetchingNextPage) void prescriptions.fetchNextPage();
          }}
        >
          {t('prescriptions.more')}
        </Button>
      )}
      {writing ? (
        <PrescriptionForm
          // A new form for each prescription revised, so nothing of another is carried over.
          key={writing.kind === 'new' ? 'new' : writing.prescription.id}
          encounterId={encounter.id}
          patientId={encounter.patientId}
          standing={standing}
          standingComplete={!prescriptions.hasNextPage}
          replaces={writing.kind === 'revise' ? writing.prescription : undefined}
          onCancel={() => setWriting(null)}
          onWritten={() => {
            const revised = writing.kind === 'revise';
            setWriting(null);
            say(t(revised ? 'prescriptions.revised' : 'prescriptions.written'));
          }}
        />
      ) : (
        // Not while the list could not be read: the duplicate check needs it.
        canWrite &&
        open &&
        prescriptions.isSuccess && (
          <Button type="button" className="self-start" onClick={() => setWriting({ kind: 'new' })}>
            {t('prescriptions.write')}
          </Button>
        )
      )}
    </section>
  );
}

function PrescriptionView({
  prescription,
  replaces,
  replacedBy,
  onRevise,
}: {
  prescription: Prescription;
  replaces: Prescription | undefined;
  replacedBy: Prescription | undefined;
  onRevise?: () => void;
}) {
  const { t } = useTranslation('clinical');
  const format = useFormatters();
  const headingId = useId();
  const replaced = prescription.replacedById !== undefined;
  const written = format.dateTime(prescription.prescribedAt);
  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col gap-3 rounded-md border p-3',
        replaced && 'text-muted-foreground',
      )}
    >
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="font-semibold">
          {t('prescriptions.writtenBy', { time: written, name: prescription.prescribedByName })}
        </h3>
        {prescription.replacesId && (
          <p className="text-sm">
            {replaces
              ? t('prescriptions.revises', {
                  time: format.dateTime(replaces.prescribedAt),
                  reason: prescription.replaceReason ?? '',
                })
              : t('prescriptions.revisesEarlier', { reason: prescription.replaceReason ?? '' })}
          </p>
        )}
        {replaced && (
          // In words, never by the muted colour alone.
          <p className="text-sm font-medium">
            {replacedBy
              ? t('prescriptions.replaced', { time: format.dateTime(replacedBy.prescribedAt) })
              : t('prescriptions.replacedLater')}
          </p>
        )}
      </div>
      <ol className="flex flex-col gap-2">
        {linesInOrder(prescription).map((line) => (
          <li key={line.id}>
            <LineView line={line} />
          </li>
        ))}
      </ol>
      {prescription.advice && (
        <div className="text-sm">
          <p className="font-medium">{t('prescriptions.advice')}</p>
          <p className="whitespace-pre-line break-words">{prescription.advice}</p>
        </div>
      )}
      {onRevise && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          aria-label={t('prescriptions.reviseLabel', { time: written })}
          onClick={onRevise}
        >
          {t('prescriptions.revise')}
        </Button>
      )}
    </article>
  );
}

/** A line: the medicine as ordered, how to take it, and where it stands when not just placed. */
function LineView({ line }: { line: Order }) {
  const { t } = useTranslation('clinical');
  const how = [
    line.dose,
    line.route ? t(`prescriptions.routes.${line.route}`) : undefined,
    line.frequency,
    line.durationDays === undefined
      ? undefined
      : t('prescriptions.days', { count: line.durationDays }),
    line.quantity === undefined ? undefined : t('prescriptions.quantity', { count: line.quantity }),
  ].filter(Boolean);
  const cancelled = line.status === 'cancelled';
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <p className={cn('break-words font-medium', cancelled && 'line-through')}>{line.itemName}</p>
      <p className="break-words">{how.join(' · ')}</p>
      {line.instructions && <p className="break-words">{line.instructions}</p>}
      {line.status !== 'placed' && (
        <p className="font-medium">
          {cancelled
            ? t('prescriptions.lineCancelled', { reason: line.cancelReason ?? '' })
            : t(`prescriptions.lineStatus.${line.status}`)}
        </p>
      )}
    </div>
  );
}
