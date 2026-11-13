import { Scale } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { useSession } from '@/app/session';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { PrintSheet } from '@/shared/ui/print-sheet';
import {
  CheckboxField,
  Form,
  SelectField,
  TextAreaField,
  TextField,
  useZodForm,
} from '@/shared/ui/form';
import { Letterhead, useFormatters } from '@/tenancy';
import { useMlc, useMlcHistory, useMlcPrinting, useSaveMlc } from '../hooks/use-emergency';
import { MLC_CATEGORIES, mlcFormSchema, type MlcFormValues } from '../schemas';
import type { EmergencyCase, EmergencyMlc } from '../types';
import { failureText } from './failure';

/** A word and an icon, never colour alone, for a case that is medico-legal. */
export function MedicoLegalBadge() {
  const { t } = useTranslation('emergency');
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-semibold">
      <Scale aria-hidden="true" className="size-3.5" />
      {t('mlc.badge')}
    </span>
  );
}

/**
 * The medico-legal record of a case (ER-03). Who may see the details is `medicoLegal:read`; who
 * may flag or revise is `medicoLegal:manage`. Without the first the screen says only that the case
 * is medico-legal. The record is read when this opens, not in the background: every view is
 * audited. A revision never overwrites the one before it.
 */
export function MedicoLegalPanel({ row }: { row: EmergencyCase }) {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const printErrorId = useId();
  const canRead = usePermission('medicoLegal:read');
  const canManage = usePermission('medicoLegal:manage');
  const printing = useMlcPrinting(row.id);
  const record = useMlc(row.id, row.medicoLegal && canRead);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [message, setMessage] = useState('');
  const status = useRef<HTMLParagraphElement>(null);

  if (!row.medicoLegal && !canManage) return null;

  const closeEditor = () => {
    setEditing(false);
    setTimeout(() => focusIfLost(status.current), 0);
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('mlc.heading')}
      </h2>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message}
      </p>

      {!row.medicoLegal ? (
        <>
          <p className="text-sm text-muted-foreground">{t('mlc.notFlagged')}</p>
          <Button className="self-start" onClick={() => setEditing(true)}>
            {t('mlc.flag')}
          </Button>
        </>
      ) : !canRead ? (
        <p className="text-sm">{t('mlc.restricted')}</p>
      ) : record.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(record.error))}
        </p>
      ) : record.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : (
        <>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Item label={t('mlc.category')} value={t(`mlc.categories.${record.data.category}`)} />
            <Item label={t('mlc.broughtBy')} value={record.data.broughtBy} />
            <Item
              label={t('mlc.police')}
              value={
                record.data.policeInformed
                  ? t('mlc.informed', { station: record.data.policeStation ?? '' })
                  : t('mlc.notInformed')
              }
            />
            <Item label={t('mlc.reference')} value={record.data.policeReference} />
            <Item
              label={t('mlc.recorded')}
              value={t('mlc.recordedBy', {
                name: record.data.recordedByName,
                at: format.dateTime(record.data.recordedAt),
                revision: record.data.revision,
              })}
            />
          </dl>
          <p className="whitespace-pre-wrap break-words">{record.data.narrative}</p>
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                {t('mlc.revise')}
              </Button>
            )}
            <Button variant="outline" onClick={() => setHistory(true)}>
              {t('mlc.historyButton')}
            </Button>
            <Button
              variant="outline"
              aria-disabled={printing.busy || undefined}
              aria-describedby={printing.error ? printErrorId : undefined}
              onClick={printing.print}
            >
              {t('mlc.print')}
            </Button>
          </div>
          {printing.error && (
            <p id={printErrorId} role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(printing.error))}
            </p>
          )}
          {printing.job && (
            <PrintSheet key={printing.job.id} onDone={printing.done}>
              <MlcDocument row={row} record={printing.job.value} />
            </PrintSheet>
          )}
        </>
      )}

      {history && (
        <MlcHistoryDialog
          row={row}
          onClose={() => {
            setHistory(false);
            setTimeout(() => focusIfLost(status.current), 0);
          }}
        />
      )}

      {editing && (
        <MedicoLegalDialog
          row={row}
          current={record.data}
          onClose={closeEditor}
          onDone={(saved) => {
            setMessage(t(saved.revision === 1 ? 'mlc.flagged' : 'mlc.revised', { id: row.tempId }));
            closeEditor();
            void record.refetch();
          }}
        />
      )}
    </section>
  );
}

/**
 * The record on paper: the letterhead, the case, the category, who brought the patient, the police
 * and the account of the injury, then who printed it, when and which revision. Drawn from the
 * answer of the print request, so it is the revision the server recorded.
 */
function MlcDocument({ row, record }: { row: EmergencyCase; record: EmergencyMlc }) {
  const { t } = useTranslation('emergency');
  const format = useFormatters();
  const printedBy = useSession()?.user.name ?? '';
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">{t('mlc.printTitle', { id: row.tempId })}</h1>
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <PrintItem label={t('mlc.category')} value={t(`mlc.categories.${record.category}`)} />
        <PrintItem label={t('mlc.broughtBy')} value={record.broughtBy} />
        <PrintItem
          label={t('mlc.police')}
          value={
            record.policeInformed
              ? t('mlc.informed', { station: record.policeStation ?? '' })
              : t('mlc.notInformed')
          }
        />
        <PrintItem label={t('mlc.reference')} value={record.policeReference} />
        <PrintItem
          label={t('mlc.recorded')}
          value={t('mlc.recordedBy', {
            name: record.recordedByName,
            at: format.dateTime(record.recordedAt),
            revision: record.revision,
          })}
        />
      </dl>
      <h2 className="font-medium">{t('mlc.narrative')}</h2>
      <p className="whitespace-pre-wrap break-words">{record.narrative}</p>
      <p className="mt-8 border-t border-black pt-2 text-xs">
        {t('mlc.printedBy', {
          time: format.dateTime(new Date().toISOString()),
          name: printedBy,
          revision: record.revision,
        })}
      </p>
    </>
  );
}

const TRACKED = [
  'category',
  'narrative',
  'broughtBy',
  'policeInformed',
  'policeStation',
  'policeReference',
] as const;
type Tracked = (typeof TRACKED)[number];
const FIELD_LABELS: Record<Tracked, string> = {
  category: 'mlc.category',
  narrative: 'mlc.narrative',
  broughtBy: 'mlc.broughtBy',
  policeInformed: 'mlc.policeInformed',
  policeStation: 'mlc.policeStation',
  policeReference: 'mlc.reference',
};

/** Every revision, newest first, each with what it changed from the one before. Read only. */
function MlcHistoryDialog({ row, onClose }: { row: EmergencyCase; onClose: () => void }) {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const revisions = useMlcHistory(row.id);

  const show = (field: Tracked, record: EmergencyMlc | undefined): string => {
    const value = record?.[field];
    if (value === undefined || value === '') return t('mlc.historyNone');
    if (typeof value === 'boolean') return t(value ? 'mlc.historyYes' : 'mlc.historyNo');
    return field === 'category' ? t(`mlc.categories.${value}`) : value;
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('mlc.historyTitle', { id: row.tempId })}
      description={t('mlc.historyDescription')}
      closeLabel={t('close')}
      footer={
        <Button variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      }
    >
      {revisions.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(revisions.error))}
        </p>
      ) : revisions.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {revisions.data.map((record, index) => {
            const before = revisions.data[index + 1];
            const changes = TRACKED.filter((field) => show(field, record) !== show(field, before));
            return (
              <li
                key={record.revision}
                className="flex flex-col gap-1 rounded-md border p-3 text-sm"
              >
                <h3 className="font-semibold">
                  {t('mlc.recordedBy', {
                    name: record.recordedByName,
                    at: format.dateTime(record.recordedAt),
                    revision: record.revision,
                  })}
                </h3>
                {before === undefined ? (
                  <>
                    <p>{t('mlc.historyFirst')}</p>
                    <p className="whitespace-pre-wrap break-words">{record.narrative}</p>
                  </>
                ) : changes.length === 0 ? (
                  <p>{t('mlc.historyNoChange')}</p>
                ) : (
                  <ul className="list-disc pl-5">
                    {changes.map((field) => (
                      <li key={field} className="whitespace-pre-wrap break-words">
                        {t('mlc.historyChanged', {
                          field: t(FIELD_LABELS[field]),
                          from: show(field, before),
                          to: show(field, record),
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Dialog>
  );
}

function PrintItem({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <>
      <dt className="font-medium">{label}</dt>
      <dd className="break-words">{value}</dd>
    </>
  );
}

function Item({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

function MedicoLegalDialog({
  row,
  current,
  onClose,
  onDone,
}: {
  row: EmergencyCase;
  current: EmergencyMlc | undefined;
  onClose: () => void;
  onDone: (saved: EmergencyMlc) => void;
}) {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const save = useSaveMlc();
  // The revision this edit started from, kept while the dialog is open.
  const [revision] = useState(current?.revision ?? 0);
  const form = useZodForm(mlcFormSchema, {
    category: current?.category ?? 'road_accident',
    narrative: current?.narrative ?? '',
    broughtBy: current?.broughtBy ?? '',
    policeInformed: current?.policeInformed ?? false,
    policeStation: current?.policeStation ?? '',
    policeReference: current?.policeReference ?? '',
  });
  const informed = form.watch('policeInformed');
  const failure = failureText(save.error, t, tCommon);

  const submit = async (values: MlcFormValues) => {
    try {
      const saved = await save.mutateAsync({
        caseId: row.id,
        revision,
        category: values.category,
        narrative: values.narrative,
        policeInformed: values.policeInformed,
        ...(values.broughtBy ? { broughtBy: values.broughtBy } : {}),
        ...(values.policeInformed ? { policeStation: values.policeStation } : {}),
        ...(values.policeReference ? { policeReference: values.policeReference } : {}),
      });
      onDone(saved);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t(revision === 0 ? 'mlc.flagTitle' : 'mlc.reviseTitle')}
      description={t('mlc.dialogDescription', { id: row.tempId })}
      closeLabel={t('close')}
      busy={save.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="emergency-mlc-form" aria-busy={save.isPending}>
            {save.isPending ? t('mlc.saving') : t('mlc.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="emergency-mlc-form" onSubmit={submit}>
        <SelectField<MlcFormValues>
          name="category"
          label={t('mlc.category')}
          required
          options={MLC_CATEGORIES.map((value) => ({ value, label: t(`mlc.categories.${value}`) }))}
        />
        <TextAreaField<MlcFormValues>
          name="narrative"
          label={t('mlc.narrative')}
          hint={t('mlc.narrativeHint')}
          required
          maxLength={2000}
        />
        <TextField<MlcFormValues>
          name="broughtBy"
          label={t('mlc.broughtBy')}
          maxLength={120}
          autoComplete="off"
        />
        <CheckboxField<MlcFormValues> name="policeInformed" label={t('mlc.policeInformed')} />
        {informed && (
          <TextField<MlcFormValues>
            name="policeStation"
            label={t('mlc.policeStation')}
            required
            maxLength={120}
            autoComplete="off"
          />
        )}
        <TextField<MlcFormValues>
          name="policeReference"
          label={t('mlc.reference')}
          maxLength={60}
          autoComplete="off"
        />
        <p className="text-sm text-muted-foreground">{t('mlc.history')}</p>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
