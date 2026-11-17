import { TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { todayIn, utcToZoned, zonedToUtc } from '@/shared/utils/timezone';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog } from '@/shared/ui/dialog';
import {
  Form,
  SelectField,
  TextAreaField,
  TextField,
  useFieldRows,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import {
  COLLECTION_UNITS_MAX,
  collectionFormSchema,
  deferFormSchema,
  DONOR_SEXES,
  donorFormSchema,
  NAME_MAX,
  PHONE_MAX,
  type CollectionFormValues,
  type DeferFormValues,
  type DonorFormValues,
} from '../donor-schemas';
import {
  useDeferDonor,
  useDonor,
  useDonorTrace,
  useRecordCollection,
  useRegisterDonor,
  useUpdateDonor,
} from '../hooks/use-blood';
import { BLOOD_COMPONENTS, BLOOD_GROUPS, REASON_MAX, UNIT_NUMBER_MAX } from '../schemas';
import type { BloodCollection, BloodDonor, BloodDonorSummary } from '../types';
import { PatientLabel } from './Dialogs';
import { instant, useDonorFailure } from './helpers';

const useToday = () => todayIn(useTenant()?.timezone ?? 'UTC');

/** Registers a donor: a person of the blood bank, not a patient. */
export function RegisterDonorDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (donor: BloodDonor) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const register = useRegisterDonor();
  const today = useToday();
  const schema = useMemo(() => donorFormSchema(today), [today]);
  const form = useZodForm(schema, {
    fullName: '',
    dateOfBirth: '',
    sex: 'female',
    bloodGroup: 'O+',
    phone: '',
  });
  const failure = useDonorFailure(register.error);

  const submit = async (values: DonorFormValues) => {
    try {
      onDone(
        await register.mutateAsync({
          fullName: values.fullName,
          dateOfBirth: values.dateOfBirth,
          sex: values.sex,
          bloodGroup: values.bloodGroup,
          ...(values.phone ? { phone: values.phone } : {}),
        }),
      );
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('donor.register.title')}
      description={t('donor.register.description')}
      closeLabel={t('close')}
      busy={register.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="blood-donor-form" aria-disabled={register.isPending}>
            {register.isPending ? t('donor.register.saving') : t('donor.register.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="blood-donor-form" onSubmit={submit}>
        <TextField<DonorFormValues>
          name="fullName"
          label={t('donor.fullName')}
          required
          maxLength={NAME_MAX}
          autoComplete="off"
          data-autofocus
        />
        <TextField<DonorFormValues>
          name="dateOfBirth"
          type="date"
          label={t('donor.dateOfBirth')}
          hint={t('donor.dateOfBirthHint')}
          required
        />
        <SelectField<DonorFormValues>
          name="sex"
          label={t('donor.sex')}
          required
          options={DONOR_SEXES.map((value) => ({ value, label: t(`donor.sexes.${value}`) }))}
        />
        <SelectField<DonorFormValues>
          name="bloodGroup"
          label={t('columns.group')}
          required
          options={BLOOD_GROUPS.map((value) => ({ value, label: value }))}
        />
        <TextField<DonorFormValues>
          name="phone"
          type="tel"
          inputMode="tel"
          label={t('donor.phone')}
          maxLength={PHONE_MAX}
          autoComplete="off"
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

const EDIT_FIELDS = ['fullName', 'dateOfBirth', 'sex', 'phone'] as const;
type EditField = (typeof EDIT_FIELDS)[number];
type EditValues = Pick<DonorFormValues, EditField>;
const editValues = (donor: BloodDonor): EditValues => ({
  fullName: donor.fullName,
  dateOfBirth: donor.dateOfBirth,
  sex: donor.sex,
  phone: donor.phone ?? '',
});

/** Reads the donor (an audited read), then offers the form: only what is typed over is sent. */
export function EditDonorDialog({
  donor,
  onClose,
  onDone,
}: {
  donor: BloodDonorSummary;
  onClose: () => void;
  onDone: (donor: BloodDonor) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const record = useDonor(donor.id);
  if (record.data) {
    return (
      <EditDonorForm
        key={donor.id}
        record={record.data}
        reread={() => record.refetch().then((result) => result.data)}
        onClose={onClose}
        onDone={onDone}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('donor.edit.title', { number: donor.donorNumber })}
      description={t('donor.edit.description')}
      closeLabel={t('close')}
    >
      {record.isError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(record.error))}
          </p>
          <Button variant="outline" onClick={() => void record.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : (
        <p role="status">{t('donor.detail.loading')}</p>
      )}
    </Dialog>
  );
}

function EditDonorForm({
  record,
  reread,
  onClose,
  onDone,
}: {
  record: BloodDonor;
  reread: () => Promise<BloodDonor | undefined>;
  onClose: () => void;
  onDone: (donor: BloodDonor) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const update = useUpdateDonor();
  const today = useToday();
  const schema = useMemo(() => donorFormSchema(today).omit({ bloodGroup: true }), [today]);
  // The record as the form opened on. After a conflict it moves to what was saved meanwhile,
  // while the form keeps what was typed.
  const [base, setBase] = useState(record);
  const [theirs, setTheirs] = useState<EditField[]>([]);
  const [conflict, setConflict] = useState(false);
  const form = useZodForm(schema, editValues(record));
  const failure = useDonorFailure(update.error);

  const submit = async (values: EditValues) => {
    const dirty = form.formState.dirtyFields;
    const body: Record<string, string | null> = {};
    for (const field of EDIT_FIELDS) {
      if (dirty[field] === true) {
        body[field] = field === 'phone' && values.phone === '' ? null : values[field];
      }
    }
    if (Object.keys(body).length === 0) return onClose();
    try {
      onDone(
        await update.mutateAsync({
          donorId: base.id,
          body: { ...body, expectedVersion: base.version },
        }),
      );
    } catch (error) {
      if (!isApiError(error) || error.serverCode !== 'conflict') return;
      const latest = await reread();
      if (!latest) return;
      const before = editValues(base);
      const after = editValues(latest);
      setTheirs(
        EDIT_FIELDS.filter((field) => dirty[field] === true && before[field] !== after[field]),
      );
      setBase(latest);
      setConflict(true);
      form.reset(after, { keepDirtyValues: true });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('donor.edit.title', { number: base.donorNumber })}
      description={t('donor.edit.description')}
      closeLabel={t('close')}
      busy={update.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="blood-donor-edit-form" aria-disabled={update.isPending}>
            {update.isPending ? t('donor.edit.saving') : t('donor.edit.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="blood-donor-edit-form" onSubmit={submit}>
        <TextField<EditValues>
          name="fullName"
          label={t('donor.fullName')}
          required
          maxLength={NAME_MAX}
          autoComplete="off"
          data-autofocus
        />
        <TextField<EditValues>
          name="dateOfBirth"
          type="date"
          label={t('donor.dateOfBirth')}
          hint={t('donor.dateOfBirthHint')}
          required
        />
        <SelectField<EditValues>
          name="sex"
          label={t('donor.sex')}
          required
          options={DONOR_SEXES.map((value) => ({ value, label: t(`donor.sexes.${value}`) }))}
        />
        <TextField<EditValues>
          name="phone"
          type="tel"
          inputMode="tel"
          label={t('donor.phone')}
          maxLength={PHONE_MAX}
          autoComplete="off"
        />
        <div role="status" className="flex flex-col gap-1 text-sm">
          {conflict && <p>{t('donor.edit.savedMeanwhile')}</p>}
          {theirs.map((field) => (
            <p key={field}>
              {t(
                field === 'fullName'
                  ? 'donor.fullName'
                  : field === 'dateOfBirth'
                    ? 'donor.dateOfBirth'
                    : field === 'sex'
                      ? 'donor.sex'
                      : 'donor.phone',
              )}
              : {t('donor.edit.theirs', { value: editValues(base)[field] || t('donor.none') })}
            </p>
          ))}
        </div>
        {failure && !conflict && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

const emptyUnit = () => ({
  unitNumber: '',
  component: 'whole_blood' as const,
  unitVolumeMl: '450',
  expiresAt: '',
});

/** One to four units made of the donation, each with its own number, component, volume and date. */
function CollectionUnits() {
  const { t } = useTranslation('blood-bank');
  const rows = useFieldRows('units');
  const many = rows.keys.length > 1;
  return (
    <div className="flex flex-col gap-3">
      {rows.keys.map((key, index) => (
        <fieldset key={key} className="flex flex-col gap-3 rounded-md border p-3">
          {many && (
            <legend className="px-1 text-sm font-medium">
              {t('collection.unitTitle', { n: index + 1 })}
            </legend>
          )}
          <TextField<CollectionFormValues>
            name={`units.${index}.unitNumber`}
            label={t('register.unitNumber')}
            required
            maxLength={UNIT_NUMBER_MAX}
            autoComplete="off"
          />
          <SelectField<CollectionFormValues>
            name={`units.${index}.component`}
            label={t('columns.component')}
            required
            options={BLOOD_COMPONENTS.map((value) => ({ value, label: t(`component.${value}`) }))}
          />
          <TextField<CollectionFormValues>
            name={`units.${index}.unitVolumeMl`}
            label={t('collection.unitVolume')}
            required
            inputMode="numeric"
            autoComplete="off"
          />
          <TextField<CollectionFormValues>
            name={`units.${index}.expiresAt`}
            type="datetime-local"
            label={t('columns.expires')}
            required
          />
          {many && (
            <Button
              type="button"
              variant="outline"
              onClick={() => rows.remove(index)}
              aria-label={t('collection.removeUnit', { n: index + 1 })}
            >
              {t('collection.removeUnitShort')}
            </Button>
          )}
        </fieldset>
      ))}
      {rows.keys.length < COLLECTION_UNITS_MAX && (
        <Button type="button" variant="outline" onClick={() => rows.add(emptyUnit())}>
          {t('collection.addUnit')}
        </Button>
      )}
    </div>
  );
}

/** Records a donation and the one to four units made of it. The unit then waits for testing. */
export function CollectionDialog({
  donor,
  onClose,
  onDone,
}: {
  donor: BloodDonorSummary;
  onClose: () => void;
  onDone: (collection: BloodCollection, unitNumbers: string[]) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const timezone = useTenant()?.timezone ?? 'UTC';
  const record = useRecordCollection();
  const now = utcToZoned(new Date().toISOString(), timezone);
  const form = useZodForm(collectionFormSchema, {
    collectedAt: `${now.day}T${now.time}`,
    volumeMl: '450',
    units: [emptyUnit()],
  });
  const failure = useDonorFailure(record.error);

  const submit = async (values: CollectionFormValues) => {
    try {
      const collection = await record.mutateAsync({
        donorId: donor.id,
        collectedAt: instant(values.collectedAt, timezone),
        volumeMl: Number(values.volumeMl),
        units: values.units.map((unit) => ({
          unitNumber: unit.unitNumber,
          component: unit.component,
          volumeMl: Number(unit.unitVolumeMl),
          expiresAt: instant(unit.expiresAt, timezone),
        })),
      });
      onDone(
        collection,
        values.units.map((unit) => unit.unitNumber),
      );
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('collection.title', { number: donor.donorNumber })}
      description={t('collection.description', { group: donor.bloodGroup })}
      closeLabel={t('close')}
      busy={record.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="blood-collection-form" aria-disabled={record.isPending}>
            {record.isPending ? t('collection.saving') : t('collection.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="blood-collection-form" onSubmit={submit}>
        <TextField<CollectionFormValues>
          name="collectedAt"
          type="datetime-local"
          label={t('columns.collected')}
          required
          data-autofocus
        />
        <TextField<CollectionFormValues>
          name="volumeMl"
          label={t('collection.volume')}
          required
          inputMode="numeric"
          autoComplete="off"
        />
        <CollectionUnits />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

/** Defers a donor until a day, or for good. A permanent deferral is final. */
export function DeferDialog({
  donor,
  onClose,
  onDone,
}: {
  donor: BloodDonorSummary;
  onClose: () => void;
  onDone: (donor: BloodDonor) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const timezone = useTenant()?.timezone ?? 'UTC';
  const defer = useDeferDonor();
  const today = useToday();
  const schema = useMemo(() => deferFormSchema(today), [today]);
  const form = useZodForm(schema, { kind: 'until', until: '', reason: '' });
  const kind = form.watch('kind');
  const failure = useDonorFailure(defer.error);

  const submit = async (values: DeferFormValues) => {
    try {
      onDone(
        await defer.mutateAsync({
          donorId: donor.id,
          body: {
            reason: values.reason,
            ...(values.kind === 'until'
              ? { until: zonedToUtc(values.until, '00:00', timezone) }
              : {}),
          },
        }),
      );
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={t('defer.title', { number: donor.donorNumber })}
      description={t('defer.description')}
      cancelLabel={t('cancel')}
      confirmLabel={defer.isPending ? t('defer.saving') : t('defer.submit')}
      confirmForm="blood-defer-form"
      destructive
      pending={defer.isPending}
    >
      <Form form={form} id="blood-defer-form" onSubmit={submit} className="gap-3">
        <SelectField<DeferFormValues>
          name="kind"
          label={t('defer.kind')}
          required
          options={[
            { value: 'until', label: t('defer.until') },
            { value: 'permanent', label: t('defer.permanent') },
          ]}
        />
        {kind === 'until' ? (
          <TextField<DeferFormValues>
            name="until"
            type="date"
            label={t('defer.untilDate')}
            hint={t('defer.untilHint')}
            required
          />
        ) : (
          <p role="status" className="flex items-start gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('defer.permanentWarning')}
          </p>
        )}
        <TextAreaField<DeferFormValues>
          name="reason"
          label={t('defer.reason')}
          required
          maxLength={REASON_MAX}
          data-autofocus
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </ConfirmDialog>
  );
}

/**
 * One donor in full. Opening it reads the whole record, which the server audits, so this is
 * mounted only when someone asks. The donor trace (units made from the donations and where they
 * went) needs `transfusionReaction:read` as well.
 */
export function DonorDialog({ donor, onClose }: { donor: BloodDonorSummary; onClose: () => void }) {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const record = useDonor(donor.id);
  const canTrace = usePermission('transfusionReaction:read');
  const trace = useDonorTrace(donor.id, canTrace);

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('donor.detail.title', { number: donor.donorNumber })}
      description={t('donor.detail.description')}
      closeLabel={t('close')}
      size="lg"
    >
      {record.isPending && <p role="status">{t('donor.detail.loading')}</p>}
      {record.isError && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(record.error))}
          </p>
          <Button variant="outline" onClick={() => void record.refetch()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {record.data && (
        <div className="flex flex-col gap-4 text-sm">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]">
            <dt className="font-medium">{t('donor.fullName')}</dt>
            <dd>{record.data.fullName}</dd>
            <dt className="font-medium">{t('donor.dateOfBirth')}</dt>
            <dd>{format.calendarDate(record.data.dateOfBirth)}</dd>
            <dt className="font-medium">{t('donor.sex')}</dt>
            <dd>{t(`donor.sexes.${record.data.sex}`)}</dd>
            <dt className="font-medium">{t('columns.group')}</dt>
            <dd>{record.data.bloodGroup}</dd>
            <dt className="font-medium">{t('donor.phone')}</dt>
            <dd>{record.data.phone ?? t('donor.none')}</dd>
            <dt className="font-medium">{t('donor.columns.status')}</dt>
            <dd>
              {record.data.deferredPermanent
                ? t('donor.status.permanent')
                : record.data.status === 'deferred' && record.data.deferredUntil
                  ? t('donor.status.until', { date: format.dateTime(record.data.deferredUntil) })
                  : t('donor.status.active')}
            </dd>
            {record.data.deferralReason && (
              <>
                <dt className="font-medium">{t('defer.reason')}</dt>
                <dd>{record.data.deferralReason}</dd>
              </>
            )}
            <dt className="font-medium">{t('donor.columns.lastDonated')}</dt>
            <dd>
              {record.data.lastDonatedAt
                ? format.dateTime(record.data.lastDonatedAt)
                : t('donor.none')}
            </dd>
          </dl>

          <section aria-labelledby="donor-collections" className="flex flex-col gap-2">
            <h3 id="donor-collections" className="font-semibold">
              {t('donor.detail.collections')}
            </h3>
            {record.data.collections.length === 0 ? (
              <p className="text-muted-foreground">{t('donor.detail.noCollections')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {record.data.collections.map((collection) => (
                  <li key={collection.id} className="rounded-md border p-2">
                    {t('donor.detail.collection', {
                      date: format.dateTime(collection.collectedAt),
                      volume: collection.volumeMl,
                      count: collection.unitIds.length,
                    })}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Can permission="transfusionReaction:read">
            <section aria-labelledby="donor-trace" className="flex flex-col gap-2">
              <h3 id="donor-trace" className="font-semibold">
                {t('donor.detail.trace')}
              </h3>
              {trace.isPending ? (
                <p role="status">{t('trace.loading')}</p>
              ) : trace.isError ? (
                <p role="alert" className="text-destructive">
                  {tCommon(errorMessageKey(trace.error))}
                </p>
              ) : trace.data.units.length === 0 ? (
                <p className="text-muted-foreground">{t('donor.detail.noUnits')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {trace.data.units.map((row) => (
                    <li key={row.unit.id} className="rounded-md border p-2">
                      <p className="font-medium">
                        {t('donor.detail.unit', {
                          number: row.unit.unitNumber,
                          status: t(`status.${row.unit.status}`),
                        })}
                      </p>
                      {row.recipientPatientId && (
                        <p>
                          {t('trace.recipient')}: <PatientLabel id={row.recipientPatientId} />
                        </p>
                      )}
                      <p>
                        {row.reactionCount === 0
                          ? t('trace.noReactions')
                          : t('donor.detail.reactions', {
                              count: row.reactionCount,
                              severity: row.worstSeverity ? t(`severity.${row.worstSeverity}`) : '',
                            })}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </Can>
        </div>
      )}
    </Dialog>
  );
}
