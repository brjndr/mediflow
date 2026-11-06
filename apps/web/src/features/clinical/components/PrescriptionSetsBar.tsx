import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { CheckboxField, Form, TextField, useZodForm } from '@/shared/ui/form';
import {
  useLoadPrescriptionSet,
  usePrescriptionSets,
  useSavePrescriptionSet,
  useSetAccess,
} from '../hooks/use-prescription-sets';
import { blankLine, LINES_MAX, type PrescriptionLineValues } from '../schemas';
import {
  isBlankLine,
  saveSetSchema,
  SET_NAME_MAX,
  setLineToValues,
  toSetLines,
  type SaveSetOutput,
  type SaveSetValues,
} from '../sets-schemas';
import type { PrescriptionSet, PrescriptionSetLine } from '../types';

const SAVE_FORM = 'save-prescription-set';
const BLANK_NAME: SaveSetValues = { name: '', shared: false };

/**
 * "Load a set" and "Save as a set" for the prescription form (#394). Loading adds a set's lines
 * to the form, up to the 30 a prescription holds, and says how many were left out and why; the
 * lines are then checked for allergies and repeats like any other, and nothing is written until
 * the doctor writes the prescription. Saving keeps the form's lines, once each is complete, as
 * the doctor's own set, or the hospital's for whoever may share. It sits outside the prescription's
 * `<form>`, which a dialog with a form of its own cannot be inside.
 */
export function PrescriptionSetsBar({
  getLines,
  setLines,
  busy,
}: {
  getLines: () => PrescriptionLineValues[];
  setLines: (lines: PrescriptionLineValues[]) => void;
  /** The prescription is being written or confirmed: nothing here changes it meanwhile. */
  busy: boolean;
}) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const access = useSetAccess();
  const panelId = useId();
  const [panel, setPanel] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const buttons = useRef<HTMLDivElement>(null);
  const sets = usePrescriptionSets(access.canRead && panel);
  const loadSet = useLoadPrescriptionSet();

  const [saving, setSaving] = useState<PrescriptionSetLine[] | null>(null);
  const [refusal, setRefusal] = useState('');
  const save = useSavePrescriptionSet();
  const form = useZodForm(saveSetSchema, BLANK_NAME);

  if (!access.canRead && !access.canManage) return null;

  const load = async (set: PrescriptionSet) => {
    if (busy || loading) return;
    setLoading(set.id);
    setMessage(t('sets.load.loading', { name: set.name }));
    try {
      const detail = await loadSet(set.id);
      const current = getLines();
      // The empty line a new form starts with makes room for the first medicine of the set.
      const kept = current.length === 1 && current[0] && isBlankLine(current[0]) ? [] : current;
      const usable = detail.lines.filter((line) => !line.drugArchived);
      const archived = detail.lines.length - usable.length;
      const added = usable.slice(0, Math.max(LINES_MAX - kept.length, 0));
      const over = usable.length - added.length;
      const next = [...kept, ...added.map(setLineToValues)];
      setLines(next.length > 0 ? next : [blankLine]);
      setMessage(
        [
          t('sets.load.added', { count: added.length, name: detail.set.name }),
          ...(archived > 0 ? [t('sets.load.skippedArchived', { count: archived })] : []),
          ...(over > 0 ? [t('sets.load.skippedFull', { count: over, max: LINES_MAX })] : []),
        ].join(' '),
      );
      setPanel(false);
      // The panel's button went away: focus stays on the control that opened it.
      requestAnimationFrame(() => buttons.current?.querySelector('button')?.focus());
    } catch (error) {
      setMessage(
        isApiError(error) && error.serverCode === 'prescription_set_not_found'
          ? t('sets.load.gone')
          : t('sets.load.failed'),
      );
    } finally {
      setLoading(null);
    }
  };

  const openSave = () => {
    if (busy) return;
    const lines = toSetLines(getLines());
    if (!lines) {
      setMessage(t('sets.save.incomplete'));
      return;
    }
    setMessage('');
    setRefusal('');
    form.reset(BLANK_NAME);
    setSaving(lines);
  };

  const submitSave = (values: SaveSetOutput) => {
    if (!saving) return;
    setRefusal('');
    save.mutate(
      {
        name: values.name,
        ...(access.canShare && values.shared ? { shared: true } : {}),
        lines: saving,
      },
      {
        onSuccess: (detail) => {
          setSaving(null);
          setMessage(
            t(detail.set.shared ? 'sets.save.savedShared' : 'sets.save.saved', {
              name: detail.set.name,
            }),
          );
        },
        onError: (error) => {
          const code = isApiError(error) ? error.serverCode : undefined;
          setRefusal(
            code === 'prescription_set_name_taken'
              ? t('sets.save.nameTaken')
              : code === 'permission_denied'
                ? t('sets.save.notAllowed')
                : code === 'unknown_drug'
                  ? t('sets.save.unknownDrug')
                  : tCommon(errorMessageKey(error)),
          );
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div ref={buttons} className="flex flex-wrap gap-2">
        {access.canRead && (
          <Button
            type="button"
            variant="outline"
            aria-expanded={panel}
            aria-controls={panel ? panelId : undefined}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) setPanel((open) => !open);
            }}
          >
            {t('sets.load.open')}
          </Button>
        )}
        {access.canManage && (
          <Button
            type="button"
            variant="outline"
            aria-disabled={busy || undefined}
            onClick={openSave}
          >
            {t('sets.save.open')}
          </Button>
        )}
      </div>
      {panel && (
        <section id={panelId} aria-label={t('sets.load.heading')} className="rounded-md border p-3">
          <h4 className="mb-2 text-sm font-semibold">{t('sets.load.heading')}</h4>
          {sets.isPending ? (
            <p className="text-sm text-muted-foreground">{t('sets.load.listLoading')}</p>
          ) : sets.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t('sets.load.listFailed')}
            </p>
          ) : sets.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('sets.load.none')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sets.data.items.map((set) => (
                <li key={set.id}>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                    aria-disabled={loading !== null || undefined}
                    onClick={() => void load(set)}
                  >
                    <span className="break-words">
                      {set.name}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {t(set.shared ? 'sets.load.sharedLines' : 'sets.load.ownLines', {
                          count: set.lineCount,
                        })}
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {/* Always on the page, so what loading or saving did is announced. */}
      <p role="status" className="text-sm text-muted-foreground">
        {message}
      </p>
      <ConfirmDialog
        open={saving !== null}
        onClose={() => setSaving(null)}
        title={t('sets.save.title')}
        description={t('sets.save.description')}
        cancelLabel={t('cancel')}
        confirmLabel={t('sets.save.confirm')}
        confirmForm={SAVE_FORM}
        pending={save.isPending}
      >
        <Form form={form} id={SAVE_FORM} onSubmit={submitSave} className="gap-3">
          <TextField<SaveSetValues>
            name="name"
            label={t('sets.save.name')}
            required
            maxLength={SET_NAME_MAX}
            autoComplete="off"
            data-autofocus
          />
          {access.canShare && (
            <CheckboxField<SaveSetValues>
              name="shared"
              label={t('sets.save.shared')}
              hint={t('sets.save.sharedHint')}
            />
          )}
          {refusal && (
            <p role="alert" className="text-sm text-destructive">
              {refusal}
            </p>
          )}
        </Form>
      </ConfirmDialog>
    </div>
  );
}
