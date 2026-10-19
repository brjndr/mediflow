import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useChangeEncounter } from '../hooks/use-clinical';
import { REASON_MAX, reasonSchema, type ReasonValues } from '../schemas';
import type { Encounter } from '../types';

const REFUSED: Record<string, string> = {
  unsigned_notes: 'encounter.refused.unsignedNotes',
  has_records: 'encounter.refused.hasRecords',
  conflict: 'encounter.refused.conflict',
  invalid_transition: 'encounter.refused.notOpen',
};

/**
 * Closing the consultation, and cancelling an encounter opened by mistake, for
 * `encounter:update` while it is open. The server refuses closing while a note is a draft, and
 * cancelling once anything is on the record; the screen says which.
 */
export function EncounterActions({ encounter }: { encounter: Encounter }) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const change = useChangeEncounter(encounter.id);
  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [done, setDone] = useState('');
  usePanelFocus(cancelling, box, status);
  const form = useZodForm(reasonSchema, { reason: '' });
  const code = isApiError(change.error) ? change.error.serverCode : undefined;
  const refused = code === undefined ? undefined : REFUSED[code];
  const failure = change.isError
    ? refused
      ? t(refused)
      : tCommon(errorMessageKey(change.error))
    : '';
  const open = encounter.status === 'open';

  // The buttons go once it is closed or cancelled: focus moves to what was done, once they have.
  useLayoutEffect(() => {
    if (done) focusIfLost(status.current);
  }, [done, open]);

  return (
    <div ref={box} className="flex flex-col gap-3 border-t pt-4">
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {done}
      </p>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      {open && !cancelling && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            aria-disabled={change.isPending || undefined}
            onClick={() => {
              if (change.isPending) return;
              change.mutate(
                { change: { kind: 'close' }, version: encounter.version },
                { onSuccess: () => setDone(t('encounter.closedNow')) },
              );
            }}
          >
            {change.isPending ? t('encounter.closing') : t('encounter.close')}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-disabled={change.isPending || undefined}
            onClick={() => {
              if (!change.isPending) setCancelling(true);
            }}
          >
            {t('encounter.cancel')}
          </Button>
        </div>
      )}
      {open && cancelling && (
        <div className="flex flex-col gap-3 rounded-md border p-3">
          <h2 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
            {t('encounter.cancelHeading')}
          </h2>
          <p className="text-sm">{t('encounter.cancelHint')}</p>
          <Form
            form={form}
            onSubmit={(values: ReasonValues) =>
              change.mutate(
                { change: { kind: 'cancel', reason: values.reason }, version: encounter.version },
                {
                  onSuccess: () => {
                    setCancelling(false);
                    setDone(t('encounter.cancelledNow'));
                  },
                },
              )
            }
          >
            <TextField<ReasonValues>
              name="reason"
              label={t('encounter.cancelReason')}
              required
              maxLength={REASON_MAX}
              autoComplete="off"
            />
            <div className="flex flex-wrap gap-2">
              <SubmitButton pending={change.isPending} variant="destructive">
                {t('encounter.cancelSubmit')}
              </SubmitButton>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  change.reset();
                  setCancelling(false);
                }}
              >
                {t('encounter.keepOpen')}
              </Button>
            </div>
          </Form>
        </div>
      )}
    </div>
  );
}
