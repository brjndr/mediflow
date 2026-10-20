import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { useFeatureFlag, usePermission } from '@/access';
import { DrugSearch, useMedicineName, type Drug } from '@/features/drugs';
import { useAllergies } from '@/features/triage';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useFieldError,
  useFieldFocusRef,
  useFieldRows,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useWritePrescription } from '../hooks/use-clinical';
import { checkLines, hasWarnings, type LineWarnings } from '../prescription-checks';
import {
  ADVICE_MAX,
  blankLine,
  blankPrescription,
  DOSE_MAX,
  INSTRUCTIONS_MAX,
  LINES_MAX,
  MEDICATION_ROUTES,
  prescriptionFormSchema,
  REASON_MAX,
  replaceable,
  toPrescriptionCreate,
  toPrescriptionValues,
  type PrescriptionLineValues,
  type PrescriptionOutput,
  type PrescriptionValues,
} from '../schemas';
import type { Order, Prescription } from '../types';

const REFUSED: Record<string, string> = {
  encounter_not_open: 'prescriptions.refused.notOpen',
  unknown_drug: 'prescriptions.refused.unknownDrug',
  unknown_prescription: 'prescriptions.refused.gone',
  prescription_not_found: 'prescriptions.refused.gone',
  already_replaced: 'prescriptions.refused.alreadyReplaced',
};

function useRefusal(error: unknown) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  const key = code === undefined ? undefined : REFUSED[code];
  return key ? t(key) : tCommon(errorMessageKey(error));
}

/**
 * The patient's allergies for the checks: the list when this person may read it and triage is
 * on, else why there is none to check against.
 */
function usePrescribingAllergies(patientId: string) {
  const allowed = usePermission('allergy:read');
  const switchedOn = useFeatureFlag('triage');
  const list = useAllergies(patientId, { enabled: allowed && switchedOn });
  if (!allowed || !switchedOn) return { items: [], notice: 'prescriptions.allergies.hidden' };
  if (list.isPending) return { items: [], notice: 'prescriptions.allergies.loading' };
  if (list.isError) return { items: [], notice: 'prescriptions.allergies.failed' };
  if (list.data.status === 'unknown')
    return { items: [], notice: 'prescriptions.allergies.unknown' };
  return { items: list.data.items, notice: undefined };
}

/**
 * Writes a prescription, or a revision of one (`replaces`): 1 to 30 lines, each a medicine from
 * the catalog with its dose, route and frequency, and advice. A revision starts from the lines it
 * would cancel, and asks why. A medicine that matches an allergy, or is prescribed twice, is
 * warned of on its line, and sending asks once more before it is written. So does sending while
 * a check could not be made: the allergies not read (yet), or prescriptions not loaded.
 */
export function PrescriptionForm({
  encounterId,
  patientId,
  standing,
  standingComplete,
  replaces,
  onCancel,
  onWritten,
}: {
  encounterId: string;
  patientId: string;
  /** The encounter's medication orders still in effect, for the duplicate check. */
  standing: Order[];
  /** Whether `standing` holds every prescription of the encounter (no page left to load). */
  standingComplete: boolean;
  replaces?: Prescription;
  onCancel: () => void;
  onWritten: (prescription: Prescription) => void;
}) {
  const { t } = useTranslation('clinical');
  const revising = replaces !== undefined;
  const schema = useMemo(() => prescriptionFormSchema(revising), [revising]);
  const initial = useMemo<PrescriptionValues>(() => {
    if (!replaces) return blankPrescription;
    const values = toPrescriptionValues(replaces);
    return values.lines.length > 0 ? values : { ...values, lines: [blankLine] };
  }, [replaces]);
  const form = useZodForm(schema, initial);
  const write = useWritePrescription(encounterId);
  const failure = useRefusal(write.error);
  const allergies = usePrescribingAllergies(patientId);
  // What the revision cancels is not in effect any more, so it is not a duplicate.
  const inEffect = useMemo(
    () =>
      standing.filter(
        (line) => !(replaces && line.prescriptionId === replaces.id && replaceable(line)),
      ),
    [standing, replaces],
  );
  const lines = useWatch({ control: form.control, name: 'lines' });
  const warnings = useMemo(
    () => checkLines(lines ?? [], allergies.items, inEffect),
    [lines, allergies.items, inEffect],
  );
  // Checks that could not be made are said before writing, as a warning is.
  const unchecked = [
    ...(allergies.notice ? [t('prescriptions.confirm.allergiesUnchecked')] : []),
    ...(standingComplete ? [] : [t('prescriptions.confirm.duplicatesUnchecked')]),
  ];
  const warned = warnings.some(hasWarnings) || unchecked.length > 0;
  const listId = useId();
  // Values that passed validation and wait for the doctor to confirm the warnings.
  const [confirming, setConfirming] = useState<PrescriptionOutput | null>(null);
  const confirmBox = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirming)
      confirmBox.current?.querySelector<HTMLElement>('[data-confirm-heading]')?.focus();
  }, [confirming]);
  const started = replaces
    ? replaces.lines.filter((line) => line.status === 'in_progress' || line.status === 'completed')
    : [];

  const send = (values: PrescriptionOutput) => {
    setConfirming(null);
    write.mutate(toPrescriptionCreate(values, replaces?.id), {
      onSuccess: onWritten,
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {revising ? t('prescriptions.form.reviseHeading') : t('prescriptions.form.heading')}
      </h3>
      {allergies.notice && <p className="text-sm text-muted-foreground">{t(allergies.notice)}</p>}
      {started.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t('prescriptions.form.startedStay', { count: started.length })}
        </p>
      )}
      <Form form={form} onSubmit={(values) => (warned ? setConfirming(values) : send(values))}>
        <fieldset
          disabled={write.isPending || confirming !== null}
          className="flex min-w-0 flex-col gap-4"
        >
          <Lines warnings={warnings} />
          <TextAreaField<PrescriptionValues>
            name="advice"
            label={t('prescriptions.form.advice')}
            hint={t('prescriptions.form.adviceHint')}
            maxLength={ADVICE_MAX}
            rows={3}
          />
          {revising && (
            <TextField<PrescriptionValues>
              name="reason"
              label={t('prescriptions.form.reason')}
              required
              maxLength={REASON_MAX}
              autoComplete="off"
            />
          )}
        </fieldset>
        {confirming ? (
          <div
            ref={confirmBox}
            className="flex flex-col gap-3 rounded-md border border-amber-600 p-3"
          >
            <h4
              data-confirm-heading
              tabIndex={-1}
              aria-describedby={listId}
              className="font-semibold outline-none"
            >
              {t('prescriptions.confirm.heading')}
            </h4>
            <div id={listId}>
              <WarningList lines={confirming.lines} warnings={warnings} />
              {unchecked.map((text) => (
                <p key={text} className="text-sm">
                  {text}
                </p>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => {
                  send(confirming);
                  // The question goes: focus to the submit button, busy in its place.
                  requestAnimationFrame(() =>
                    focusIfLost(actions.current?.querySelector<HTMLElement>('button')),
                  );
                }}
              >
                {t('prescriptions.confirm.anyway')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setConfirming(null);
                  // Back to the first line warned of, once the fieldset takes input again.
                  const first = warnings.findIndex(hasWarnings);
                  requestAnimationFrame(() =>
                    focusIfLost(
                      document.querySelector<HTMLElement>(
                        `[data-line="${first}"] input, [data-line="${first}"] button`,
                      ),
                    ),
                  );
                }}
              >
                {t('prescriptions.confirm.back')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {failure && (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            )}
            <div ref={actions} className="flex flex-wrap gap-2">
              <SubmitButton pending={write.isPending}>
                {write.isPending
                  ? t('prescriptions.form.saving')
                  : revising
                    ? t('prescriptions.form.submitRevision')
                    : t('prescriptions.form.submit')}
              </SubmitButton>
              <Button type="button" variant="outline" onClick={onCancel}>
                {t('cancel')}
              </Button>
            </div>
          </>
        )}
      </Form>
    </div>
  );
}

/** What the doctor is asked to confirm: each line warned of, and why. */
function WarningList({
  lines,
  warnings,
}: {
  lines: PrescriptionOutput['lines'];
  warnings: LineWarnings[];
}) {
  const { t } = useTranslation('clinical');
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {warnings.map((warning, index) =>
        hasWarnings(warning) ? (
          <li key={index} className="break-words">
            <span className="font-medium">
              {t('prescriptions.form.lineLegend', { number: index + 1 })}
              {lines[index]?.drugName ? `, ${lines[index].drugName}` : ''}
            </span>
            {': '}
            {warningTexts(warning, t).join(' ')}
          </li>
        ) : null,
      )}
    </ul>
  );
}

function warningTexts(warning: LineWarnings, t: TFunction<'clinical'>) {
  return [
    ...warning.allergies.map((substance) => t('prescriptions.warnings.allergy', { substance })),
    ...(warning.repeated ? [t('prescriptions.warnings.repeated')] : []),
    ...(warning.prescribed.length > 0
      ? [t('prescriptions.warnings.prescribed', { names: warning.prescribed.join(', ') })]
      : []),
  ];
}

function Lines({ warnings }: { warnings: LineWarnings[] }) {
  const { t } = useTranslation('clinical');
  const rows = useFieldRows('lines');
  const add = useRef<HTMLDivElement>(null);
  const linesError = useFieldError('lines');
  // A removed line's button goes with it: focus moves to "Add a medicine".
  const [removed, setRemoved] = useState(0);
  useEffect(() => {
    if (removed > 0) focusIfLost(add.current?.querySelector('button'));
  }, [removed]);
  return (
    <>
      {rows.keys.map((key, index) => (
        <Line
          key={key}
          index={index}
          warnings={warnings[index]}
          removable={rows.keys.length > 1}
          onRemove={() => {
            rows.remove(index);
            setRemoved((count) => count + 1);
          }}
        />
      ))}
      {linesError && (
        <p role="alert" className="text-sm text-destructive">
          {linesError}
        </p>
      )}
      <div ref={add}>
        {rows.keys.length < LINES_MAX ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              rows.add(blankLine);
              // To the new line's search, once it is drawn.
              const next = rows.keys.length;
              requestAnimationFrame(() =>
                document.querySelector<HTMLElement>(`[data-line="${next}"] input`)?.focus(),
              );
            }}
          >
            {t('prescriptions.form.addLine')}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('prescriptions.form.linesMax', { count: LINES_MAX })}
          </p>
        )}
      </div>
    </>
  );
}

function Line({
  index,
  warnings,
  removable,
  onRemove,
}: {
  index: number;
  warnings: LineWarnings | undefined;
  removable: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation('clinical');
  const name = (field: keyof PrescriptionLineValues) => `lines.${index}.${field}`;
  const texts = warnings ? warningTexts(warnings, t) : [];
  return (
    <fieldset data-line={index} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">
        {t('prescriptions.form.lineLegend', { number: index + 1 })}
      </legend>
      <Medicine index={index} />
      {texts.length > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-amber-100 p-2 text-sm text-amber-950">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p className="break-words">
            <span className="font-medium">{t('prescriptions.warnings.label')} </span>
            {texts.join(' ')}
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-3">
        <TextField
          name={name('dose')}
          label={t('prescriptions.form.dose')}
          hint={t('prescriptions.form.doseHint')}
          required
          maxLength={DOSE_MAX}
          autoComplete="off"
        />
        <SelectField
          name={name('route')}
          label={t('prescriptions.form.route')}
          required
          options={MEDICATION_ROUTES.map((value) => ({
            value,
            label: t(`prescriptions.routes.${value}`),
          }))}
        />
        <TextField
          name={name('frequency')}
          label={t('prescriptions.form.frequency')}
          hint={t('prescriptions.form.frequencyHint')}
          required
          maxLength={DOSE_MAX}
          autoComplete="off"
        />
        <TextField
          name={name('durationDays')}
          label={t('prescriptions.form.days')}
          inputMode="numeric"
          maxLength={3}
          autoComplete="off"
        />
        <TextField
          name={name('quantity')}
          label={t('prescriptions.form.quantity')}
          hint={t('prescriptions.form.quantityHint')}
          inputMode="numeric"
          maxLength={5}
          autoComplete="off"
        />
      </div>
      <TextField
        name={name('instructions')}
        label={t('prescriptions.form.instructions')}
        hint={t('prescriptions.form.instructionsHint')}
        maxLength={INSTRUCTIONS_MAX}
        autoComplete="off"
      />
      {removable && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onRemove}>
          {t('prescriptions.form.removeLine', { number: index + 1 })}
        </Button>
      )}
    </fieldset>
  );
}

/** The medicine of a line: the search until one is chosen, then its name and "Change". */
function Medicine({ index }: { index: number }) {
  const { t } = useTranslation('clinical');
  const field = `lines.${index}`;
  const drugName = useFieldValue(`${field}.drugName`) as string;
  const drugId = useFieldValue(`${field}.drugId`) as string;
  const set = useSetFieldValue();
  const nameOf = useMedicineName();
  const error = useFieldError(`${field}.drugId`);
  const focusRef = useFieldFocusRef(`${field}.drugId`);
  const errorId = useId();
  const box = useRef<HTMLDivElement | null>(null);

  const choose = (drug: Drug | null) => {
    set(`${field}.drugName`, drug ? nameOf(drug) : '');
    set(`${field}.genericName`, drug?.genericName ?? '');
    set(`${field}.brandName`, drug?.brandName ?? '');
    set(`${field}.drugId`, drug?.id ?? '');
    // The search and the chosen medicine take each other's place: focus goes to what replaced it.
    requestAnimationFrame(() =>
      focusIfLost(box.current?.querySelector<HTMLElement>('button, input')),
    );
  };

  return (
    <div
      ref={(element) => {
        box.current = element;
        focusRef(element);
      }}
      className="flex flex-col gap-1.5"
    >
      {drugId ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{t('prescriptions.form.medicine')}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="break-words">{drugName}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t('prescriptions.form.changeMedicine', { name: drugName })}
              onClick={() => choose(null)}
            >
              {t('prescriptions.form.change')}
            </Button>
          </div>
        </div>
      ) : (
        <DrugSearch
          label={t('prescriptions.form.medicine')}
          onSelect={choose}
          invalid={error !== undefined}
          describedBy={error ? errorId : undefined}
        />
      )}
      {error && (
        // Linked to the search box; the form kit moves focus to it on a failed submit.
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
