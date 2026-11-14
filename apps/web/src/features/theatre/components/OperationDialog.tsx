import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { DrugSearch, useMedicineName, type Drug } from '@/features/drugs';
import { usePlaces, useStock } from '@/features/inventory';
import { useEncounters } from '@/features/clinical';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import {
  useAddAddendum,
  useConsumables,
  useLinkEncounter,
  useOperation,
  useRecordConsumables,
  useSaveOperationNote,
  useSignOperationNote,
} from '../hooks/use-theatre';
import {
  addendumFormSchema,
  consumableFormSchema,
  operationNoteFormSchema,
  visitFormSchema,
  type AddendumFormValues,
  type ConsumableFormValues,
  type OperationNoteFormValues,
  type VisitFormValues,
} from '../schemas';
import type { OperationRecord, Surgery } from '../types';

const KNOWN_ERRORS = [
  'invalid_state',
  'invalid_transition',
  'already_signed',
  'not_signed',
  'note_not_found',
  'unknown_encounter',
  'insufficient_stock',
  'batch_expired',
  'unknown_batch',
  'unknown_location',
  'unknown_item',
  'duplicate_batch',
  'feature_disabled',
];

function Failure({ error }: { error: unknown }) {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  if (!error) return null;
  const text =
    isApiError(error) && error.serverCode && KNOWN_ERRORS.includes(error.serverCode)
      ? t(`operation.errors.${error.serverCode}`)
      : tCommon(errorMessageKey(error));
  return (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  );
}

const noteDefaults = (record: OperationRecord): OperationNoteFormValues => ({
  procedureDone: record.note?.procedureDone ?? '',
  findings: record.note?.findings ?? '',
  technique: record.note?.technique ?? '',
  complications: record.note?.complications ?? '',
  bloodLossMl: record.note?.bloodLossMl === undefined ? '' : String(record.note.bloodLossMl),
  specimens: record.note?.specimens ?? '',
  postOpPlan: record.note?.postOpPlan ?? '',
});

function VisitSection({
  surgery,
  record,
  onSaved,
}: {
  surgery: Surgery;
  record: OperationRecord;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('theatre');
  const format = useFormatters();
  const canLink = usePermission('surgery:schedule');
  const open = surgery.status === 'scheduled' || surgery.status === 'in_progress';
  const link = useLinkEncounter(surgery.id);
  const form = useZodForm(visitFormSchema, { encounterId: '' });
  const visits = useEncounters(
    { patientId: surgery.patientId, status: 'open' },
    { enabled: canLink && open },
  );
  const options = visits.data?.pages.flatMap((page) => page.items) ?? [];
  const save = async (values: VisitFormValues) => {
    try {
      await link.mutateAsync(values.encounterId);
      form.reset({ encounterId: '' });
      onSaved(t('operation.done.linked'));
    } catch {
      // Said below, from the mutation state.
    }
  };
  return (
    <section aria-labelledby="op-visit-heading" className="flex flex-col gap-3">
      <h3 id="op-visit-heading" className="text-base font-semibold">
        {t('operation.visit.heading')}
      </h3>
      <p className="text-sm text-muted-foreground">
        {record.encounterId ? t('operation.visit.linked') : t('operation.visit.none')}
      </p>
      {canLink && open && (
        <Form form={form} id="operation-visit-form" onSubmit={save}>
          <SelectField<VisitFormValues>
            name="encounterId"
            label={t('operation.visit.label')}
            required
            placeholder={
              options.length === 0 && !visits.isPending
                ? t('operation.visit.noneOpen')
                : t('operation.visit.choose')
            }
            options={options.map((visit) => ({
              value: visit.id,
              label: t('operation.visit.option', {
                type: t(`operation.visit.types.${visit.type}`),
                time: format.dateTime(visit.openedAt),
              }),
            }))}
          />
          <Failure error={link.error} />
          <div>
            <SubmitButton variant="outline" pending={link.isPending}>
              {t('operation.visit.save')}
            </SubmitButton>
          </div>
        </Form>
      )}
    </section>
  );
}

function NoteSection({
  surgery,
  record,
  onSaved,
}: {
  surgery: Surgery;
  record: OperationRecord;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('theatre');
  const format = useFormatters();
  const canPerform = usePermission('surgery:perform');
  const started = surgery.status === 'in_progress' || surgery.status === 'completed';
  const note = record.note;
  const signed = note?.signedAt !== undefined;
  const save = useSaveOperationNote(surgery.id);
  const sign = useSignOperationNote(surgery.id);
  const addendum = useAddAddendum(surgery.id);
  const form = useZodForm(operationNoteFormSchema, noteDefaults(record));
  const addendumForm = useZodForm(addendumFormSchema, { text: '' });

  const submit = async (values: OperationNoteFormValues) => {
    try {
      await save.mutateAsync({
        procedureDone: values.procedureDone,
        ...(values.findings ? { findings: values.findings } : {}),
        ...(values.technique ? { technique: values.technique } : {}),
        ...(values.complications ? { complications: values.complications } : {}),
        ...(values.bloodLossMl !== '' ? { bloodLossMl: Number(values.bloodLossMl) } : {}),
        ...(values.specimens ? { specimens: values.specimens } : {}),
        ...(values.postOpPlan ? { postOpPlan: values.postOpPlan } : {}),
      });
      form.reset(values);
      onSaved(t('operation.done.noteSaved'));
    } catch {
      // Said below, from the mutation state.
    }
  };
  const signNow = async () => {
    sign.reset();
    try {
      await sign.mutateAsync();
      onSaved(t('operation.done.noteSigned'));
    } catch {
      // Said below, from the mutation state.
    }
  };
  const addNow = async (values: AddendumFormValues) => {
    try {
      await addendum.mutateAsync(values.text);
      addendumForm.reset({ text: '' });
      onSaved(t('operation.done.addendum'));
    } catch {
      // Said below, from the mutation state.
    }
  };

  const field = (label: string, value: string | number | undefined) =>
    value === undefined || value === '' ? null : (
      <div className="sm:col-span-2">
        <dt className="font-medium">{label}</dt>
        <dd className="whitespace-pre-wrap">{value}</dd>
      </div>
    );

  return (
    <section aria-labelledby="op-note-heading" className="flex flex-col gap-3">
      <h3 id="op-note-heading" className="text-base font-semibold">
        {t('operation.note.heading')}
      </h3>
      {!started && (
        <p className="text-sm text-muted-foreground">{t('operation.note.notStarted')}</p>
      )}
      {signed && note ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {field(t('operation.note.procedureDone'), note.procedureDone)}
          {field(t('operation.note.findings'), note.findings)}
          {field(t('operation.note.technique'), note.technique)}
          {field(t('operation.note.complications'), note.complications)}
          {field(t('operation.note.bloodLoss'), note.bloodLossMl)}
          {field(t('operation.note.specimens'), note.specimens)}
          {field(t('operation.note.postOpPlan'), note.postOpPlan)}
          <p className="text-muted-foreground sm:col-span-2">
            {t('operation.note.signedBy', {
              name: note.signedByName ?? '',
              time: note.signedAt ? format.dateTime(note.signedAt) : '',
            })}
          </p>
        </dl>
      ) : !canPerform || !started ? (
        <p className="text-sm text-muted-foreground">
          {note ? t('operation.note.unsigned') : t('operation.note.none')}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {note
              ? t('operation.note.draftSaved', { time: format.dateTime(note.savedAt) })
              : t('operation.note.none')}
          </p>
          <Form form={form} id="operation-note-form" onSubmit={submit}>
            <TextField<OperationNoteFormValues>
              name="procedureDone"
              label={t('operation.note.procedureDone')}
              required
            />
            <TextAreaField<OperationNoteFormValues>
              name="findings"
              label={t('operation.note.findings')}
            />
            <TextAreaField<OperationNoteFormValues>
              name="technique"
              label={t('operation.note.technique')}
            />
            <TextAreaField<OperationNoteFormValues>
              name="complications"
              label={t('operation.note.complications')}
            />
            <TextField<OperationNoteFormValues>
              name="bloodLossMl"
              label={t('operation.note.bloodLoss')}
              inputMode="numeric"
            />
            <TextAreaField<OperationNoteFormValues>
              name="specimens"
              label={t('operation.note.specimens')}
            />
            <TextAreaField<OperationNoteFormValues>
              name="postOpPlan"
              label={t('operation.note.postOpPlan')}
            />
            <Failure error={save.error ?? sign.error} />
            <div className="flex flex-wrap gap-2">
              <SubmitButton variant="outline" pending={save.isPending}>
                {t('operation.note.save')}
              </SubmitButton>
              {note && (
                <Button
                  aria-disabled={sign.isPending || form.formState.isDirty || undefined}
                  onClick={() => !sign.isPending && !form.formState.isDirty && void signNow()}
                >
                  {t('operation.note.sign')}
                </Button>
              )}
            </div>
            {note && form.formState.isDirty && (
              <p className="text-sm text-muted-foreground">{t('operation.note.saveFirst')}</p>
            )}
          </Form>
        </>
      )}
      {record.addenda.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">{t('operation.addenda.heading')}</h4>
          <ul className="flex flex-col divide-y rounded-md border">
            {record.addenda.map((each) => (
              <li key={each.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                <span className="whitespace-pre-wrap">{each.text}</span>
                <span className="text-muted-foreground">
                  {t('operation.addenda.by', {
                    name: each.addedByName,
                    time: format.dateTime(each.addedAt),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {signed && canPerform && (
        <Form form={addendumForm} id="operation-addendum-form" onSubmit={addNow}>
          <TextAreaField<AddendumFormValues>
            name="text"
            label={t('operation.addenda.label')}
            hint={t('operation.addenda.description')}
            required
          />
          <Failure error={addendum.error} />
          <div>
            <SubmitButton variant="outline" pending={addendum.isPending}>
              {t('operation.addenda.add')}
            </SubmitButton>
          </div>
        </Form>
      )}
    </section>
  );
}

/** The batch choices follow the item and the place chosen; the server picks nothing for us. */
function BatchField({ drugId }: { drugId: string }) {
  const { t } = useTranslation('theatre');
  const format = useFormatters();
  const locationId = String(useFieldValue('locationId') ?? '');
  const stock = useStock(
    { locationId, drugId, alert: '', expiringWithinDays: 90 },
    locationId !== '' && drugId !== '',
  );
  const batches = stock.data?.pages[0]?.items[0]?.batches ?? [];
  return (
    <SelectField<ConsumableFormValues>
      name="batchId"
      label={t('operation.stock.batch')}
      required
      placeholder={
        locationId === ''
          ? t('operation.stock.placeFirst')
          : batches.length === 0 && !stock.isPending
            ? t('operation.stock.noBatches')
            : t('operation.stock.chooseBatch')
      }
      options={batches
        .filter((batch) => batch.expiry !== 'expired')
        .map((batch) => ({
          value: batch.batchId,
          label: t('operation.stock.batchOption', {
            number: batch.batchNumber,
            expiry: format.calendarDate(batch.expiryDate),
            count: batch.onHand,
          }),
        }))}
    />
  );
}

function StockSection({
  surgery,
  onSaved,
}: {
  surgery: Surgery;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('theatre');
  const format = useFormatters();
  const nameOf = useMedicineName();
  const canPerform = usePermission('surgery:perform');
  const started = surgery.status === 'in_progress' || surgery.status === 'completed';
  const used = useConsumables(surgery.id);
  const record = useRecordConsumables();
  const places = usePlaces(canPerform && started);
  const [drug, setDrug] = useState<Drug>();
  const form = useZodForm(consumableFormSchema, { locationId: '', batchId: '', quantity: '' });
  const items = useMemo(() => used.data?.pages.flatMap((page) => page.items) ?? [], [used.data]);

  const submit = async (values: ConsumableFormValues) => {
    if (!drug) return;
    record.reset();
    try {
      await record.mutateAsync({
        surgeryId: surgery.id,
        drugId: drug.id,
        locationId: values.locationId,
        lines: [{ batchId: values.batchId, quantity: Number(values.quantity) }],
      });
      form.reset({ locationId: values.locationId, batchId: '', quantity: '' });
      onSaved(t('operation.done.stock', { name: nameOf(drug) }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <section aria-labelledby="op-stock-heading" className="flex flex-col gap-3">
      <h3 id="op-stock-heading" className="text-base font-semibold">
        {t('operation.stock.heading')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('operation.stock.description')}</p>
      {used.isPending ? (
        <p className="text-sm">{t('operation.loading')}</p>
      ) : used.isError ? (
        <div className="flex flex-col items-start gap-2">
          <Failure error={used.error} />
          <Button variant="outline" onClick={() => void used.refetch()}>
            {t('operation.retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('operation.stock.none')}</p>
      ) : (
        <ul
          aria-label={t('operation.stock.listLabel')}
          className="flex flex-col divide-y rounded-md border"
        >
          {items.map((each) => (
            <li key={each.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
              <span className="font-medium">
                {t('operation.stock.line', { name: each.itemName, count: each.quantity })}
              </span>
              <span className="text-muted-foreground">
                {t('operation.stock.lineDetail', {
                  batch: each.batchNumber,
                  place: each.locationName,
                  time: format.dateTime(each.recordedAt),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {used.hasNextPage && (
        <div>
          <Button variant="outline" onClick={() => void used.fetchNextPage()}>
            {t('operation.stock.more')}
          </Button>
        </div>
      )}
      {canPerform && started && (
        <div className="flex flex-col gap-3 rounded-md border p-3">
          <h4 className="text-sm font-semibold">{t('operation.stock.addHeading')}</h4>
          <DrugSearch
            label={t('operation.stock.item')}
            includeConsumables
            onSelect={(picked) => {
              setDrug(picked);
              form.setValue('batchId', '');
            }}
          />
          <p className="text-sm" aria-live="polite">
            {drug ? t('operation.stock.chosen', { name: nameOf(drug) }) : t('operation.stock.pick')}
          </p>
          <Form form={form} id="operation-stock-form" onSubmit={submit}>
            <SelectField<ConsumableFormValues>
              name="locationId"
              label={t('operation.stock.place')}
              required
              placeholder={t('operation.stock.choosePlace')}
              options={places.map((place) => ({ value: place.id, label: place.name }))}
            />
            <BatchField drugId={drug?.id ?? ''} />
            <TextField<ConsumableFormValues>
              name="quantity"
              label={t('operation.stock.quantity')}
              inputMode="numeric"
              required
            />
            {!drug && (
              <p className="text-sm text-muted-foreground">{t('operation.stock.itemFirst')}</p>
            )}
            <Failure error={record.error} />
            <div>
              <SubmitButton pending={record.isPending}>{t('operation.stock.record')}</SubmitButton>
            </div>
          </Form>
        </div>
      )}
    </section>
  );
}

/**
 * The operation note, the stock used and the visit the surgery is charged to (#178). Everyone
 * with the theatre reads it; `surgery:perform` writes the note and the stock used,
 * `surgery:schedule` names the visit. Stock used leaves the ledger when recorded and is charged
 * with the procedure when the surgery has a visit.
 */
export function OperationDialog({ surgery, onClose }: { surgery: Surgery; onClose: () => void }) {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  const operation = useOperation(surgery.id);
  const [done, setDone] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  const said = (message: string) => {
    setDone(message);
    // The button that was pressed may be gone by now.
    setTimeout(() => focusIfLost(statusLine.current), 0);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('operation.title', { procedure: surgery.procedure })}
      description={t('operation.description')}
      closeLabel={t('close')}
      size="lg"
      footer={<Button onClick={onClose}>{t('close')}</Button>}
    >
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done}
      </p>
      {operation.isPending ? (
        <p>{t('operation.loading')}</p>
      ) : operation.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(operation.error))}
          </p>
          <Button variant="outline" onClick={() => void operation.refetch()}>
            {t('operation.retry')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <VisitSection surgery={surgery} record={operation.data} onSaved={said} />
          <NoteSection surgery={surgery} record={operation.data} onSaved={said} />
          <StockSection surgery={surgery} onSaved={said} />
        </div>
      )}
    </Dialog>
  );
}
