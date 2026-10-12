import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import {
  Form,
  SelectField,
  SubmitButton,
  TextField,
  useFieldRows,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useLabRanges, useResolveLabRange, useSaveLabRanges } from '../hooks/use-lab-tests';
import {
  AGE_UNITS,
  blankRangeRow,
  fromDays,
  PATIENT_SEXES,
  RANGE_SEXES,
  rangesFormSchema,
  resolveFormSchema,
  sortRanges,
  toDays,
  toRange,
  toRangeRow,
  type RangesFormValues,
  type ResolveFormValues,
} from '../schemas';
import type { LabRange, LabRanges } from '../types';

const MANAGE = 'labTest:manage';

/** A range as a person reads it: whom it is for, the ages, what is normal and what is critical. */
function useRangeText(unit: string | undefined) {
  const { t } = useTranslation('lab_tests');
  const format = useFormatters();
  return useMemo(() => {
    const value = (amount: number) => format.number(amount, { maximumFractionDigits: 6 });
    // The unit goes with the number it measures: 20 mm/h or less.
    const withUnit = (amount: number) => (unit ? `${value(amount)} ${unit}` : value(amount));
    const age = (days: number) => {
      const { value: count, unit: ageUnit } = fromDays(days);
      return t(`ranges.ages.${ageUnit}`, { count });
    };
    return {
      sex: (range: LabRange) => t(`ranges.sexes.${range.sex}`),
      age: (range: LabRange) => {
        const until = range.ageToDays === undefined ? undefined : age(range.ageToDays + 1);
        if (range.ageFromDays === 0) {
          return until ? t('ranges.ages.under', { until }) : t('ranges.ages.all');
        }
        const from = age(range.ageFromDays);
        return until ? t('ranges.ages.between', { from, until }) : t('ranges.ages.from', { from });
      },
      normal: ({ low, high }: LabRange) => {
        if (low !== undefined && high !== undefined) {
          return t('ranges.normal.between', { low: value(low), high: withUnit(high) });
        }
        if (low !== undefined) return t('ranges.normal.atLeast', { low: withUnit(low) });
        return high === undefined ? '' : t('ranges.normal.atMost', { high: withUnit(high) });
      },
      critical: ({ criticalLow, criticalHigh }: LabRange) =>
        [
          criticalLow !== undefined && t('ranges.critical.low', { value: value(criticalLow) }),
          criticalHigh !== undefined && t('ranges.critical.high', { value: value(criticalHigh) }),
        ]
          .filter(Boolean)
          .join(' · ') || t('ranges.critical.none'),
    };
  }, [t, format, unit]);
}

/** The rows of the ranges form: one group of fields for each range. */
function RangeRows() {
  const { t } = useTranslation('lab_tests');
  const rows = useFieldRows('rows');
  const units = AGE_UNITS.map((value) => ({ value, label: t(`ranges.ageUnits.${value}`) }));
  return (
    <>
      {rows.keys.map((key, index) => {
        const name = (field: string) => `rows.${index}.${field}`;
        return (
          <fieldset key={key} className="flex flex-col gap-3 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">
              {t('ranges.editor.row', { number: index + 1 })}
            </legend>
            <div className="grid grid-cols-5 items-start gap-3">
              <SelectField
                name={name('sex')}
                label={t('ranges.editor.sex')}
                options={RANGE_SEXES.map((value) => ({
                  value,
                  label: t(`ranges.sexes.${value}`),
                }))}
              />
              <TextField
                name={name('fromValue')}
                label={t('ranges.editor.fromValue')}
                required
                inputMode="numeric"
                maxLength={5}
                autoComplete="off"
              />
              <SelectField
                name={name('fromUnit')}
                label={t('ranges.editor.fromUnit')}
                options={units}
              />
              <TextField
                name={name('untilValue')}
                label={t('ranges.editor.untilValue')}
                hint={t('ranges.editor.untilValueHint')}
                inputMode="numeric"
                maxLength={5}
                autoComplete="off"
              />
              <SelectField
                name={name('untilUnit')}
                label={t('ranges.editor.untilUnit')}
                options={units}
              />
            </div>
            <div className="grid grid-cols-4 items-start gap-3">
              {(['low', 'high', 'criticalLow', 'criticalHigh'] as const).map((field) => (
                <TextField
                  key={field}
                  name={name(field)}
                  label={t(`ranges.editor.${field}`)}
                  hint={
                    field === 'criticalLow' || field === 'criticalHigh'
                      ? t('ranges.editor.optional')
                      : undefined
                  }
                  inputMode="decimal"
                  maxLength={17}
                  autoComplete="off"
                />
              ))}
            </div>
            <TextField
              name={name('note')}
              label={t('ranges.editor.note')}
              hint={t('ranges.editor.optional')}
              maxLength={150}
              autoComplete="off"
            />
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => rows.remove(index)}
            >
              {t('ranges.editor.remove', { number: index + 1 })}
            </Button>
          </fieldset>
        );
      })}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={rows.keys.length >= 60}
        onClick={() => rows.add(blankRangeRow)}
      >
        {t('ranges.editor.add')}
      </Button>
    </>
  );
}

/** The ranges form, working from the ranges as they were when it opened. */
function Editor({
  from,
  pending,
  saving,
  onSave,
  onCancel,
}: {
  from: LabRange[];
  /** No save can be started just now. */
  pending: boolean;
  /** A save is on its way, so the form is not left either. */
  saving: boolean;
  onSave: (ranges: LabRange[]) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('lab_tests');
  const form = useZodForm(rangesFormSchema, { rows: from.map(toRangeRow) });
  // Some rules are between fields and between rows (two ranges sharing an age), and are put right
  // in a field other than the one that says so. Once Save has been tried, every change checks
  // all the rows again, so no message stays that is no longer true.
  const { isSubmitted } = form.formState;
  useEffect(() => {
    if (!isSubmitted) return;
    const watching = form.watch(() => void form.trigger('rows'));
    return () => watching.unsubscribe();
  }, [form, isSubmitted]);
  return (
    <Form
      form={form}
      onSubmit={(values: RangesFormValues) => onSave(values.rows.map(toRange))}
      className="flex flex-col gap-4"
    >
      <p className="text-xs text-muted-foreground">{t('ranges.editor.ageNote')}</p>
      <RangeRows />
      <div className="flex flex-wrap gap-3">
        <SubmitButton pending={pending}>{t('ranges.editor.save')}</SubmitButton>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          {t('ranges.editor.cancel')}
        </Button>
      </div>
    </Form>
  );
}

/** Asks the server which saved range a patient of an age and a sex would be read against. */
function Check({ labTestId, unit }: { labTestId: string; unit: string | undefined }) {
  const { t } = useTranslation('lab_tests');
  const { t: tCommon } = useTranslation();
  const text = useRangeText(unit);
  const resolve = useResolveLabRange(labTestId);
  const form = useZodForm(resolveFormSchema, { ageValue: '', ageUnit: 'years', sex: '' });
  // An answer is about the age and sex it was asked for: it goes when they are changed.
  const { reset } = resolve;
  useEffect(() => {
    const watching = form.watch(() => reset());
    return () => watching.unsubscribe();
  }, [form, reset]);

  const submit = (values: ResolveFormValues) =>
    resolve
      .mutateAsync({ ageDays: toDays(Number(values.ageValue), values.ageUnit), sex: values.sex })
      .then(
        () => undefined,
        () => undefined, // Shown from the mutation state below.
      );

  const found = resolve.data;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{t('ranges.check.heading')}</h3>
        <p className="text-sm text-muted-foreground">{t('ranges.check.description')}</p>
      </div>
      <Form form={form} onSubmit={submit} className="flex max-w-xl flex-col gap-4">
        <div className="grid grid-cols-3 items-start gap-3">
          <TextField
            name="ageValue"
            label={t('ranges.check.ageValue')}
            required
            inputMode="numeric"
            maxLength={5}
            autoComplete="off"
          />
          <SelectField
            name="ageUnit"
            label={t('ranges.check.ageUnit')}
            options={AGE_UNITS.map((value) => ({ value, label: t(`ranges.ageUnits.${value}`) }))}
          />
          <SelectField
            name="sex"
            label={t('ranges.check.sex')}
            required
            placeholder={t('ranges.check.chooseSex')}
            options={PATIENT_SEXES.map((value) => ({ value, label: t(`ranges.sexes.${value}`) }))}
          />
        </div>
        <SubmitButton pending={resolve.isPending} variant="outline" className="self-start">
          {t('ranges.check.submit')}
        </SubmitButton>
      </Form>
      {resolve.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(resolve.error))}
        </p>
      )}
      <p role="status" className="text-sm">
        {found === undefined
          ? ''
          : found === null
            ? t('ranges.check.notFound')
            : t('ranges.check.found', {
                who: text.sex(found),
                age: text.age(found),
                normal: text.normal(found),
                critical: text.critical(found),
              })}
      </p>
    </div>
  );
}

function Loaded({
  labTestId,
  unit,
  archived,
  saved,
  refreshFailed,
}: {
  labTestId: string;
  unit: string | undefined;
  archived: boolean;
  saved: LabRanges;
  refreshFailed: boolean;
}) {
  const { t } = useTranslation('lab_tests');
  const { t: tCommon } = useTranslation();
  const text = useRangeText(unit);
  const mayManage = usePermission(MANAGE);
  const save = useSaveLabRanges(labTestId);
  // The ranges as they were when the form opened: a refresh never changes what is being typed.
  const [editing, setEditing] = useState<LabRange[] | null>(null);
  // The version a save is made from. After a conflict it moves to the newest one, so saving
  // again is a decision to put these ranges in place of the ones saved meanwhile.
  const [expected, setExpected] = useState(saved.version);
  const [conflict, setConflict] = useState<'none' | 'awaiting' | 'shown'>('none');
  const [done, setDone] = useState<string | null>(null);

  if (conflict === 'awaiting' && saved.version !== expected) {
    setExpected(saved.version);
    setConflict('shown');
  } else if (conflict === 'awaiting' && refreshFailed) {
    setConflict('shown');
  }

  const rows = useMemo(() => sortRanges(saved.ranges), [saved.ranges]);
  const columns = useMemo<GridColumn<LabRange>[]>(
    () => [
      { id: 'sex', header: t('ranges.columns.sex'), value: text.sex, hideable: false },
      { id: 'age', header: t('ranges.columns.age'), value: text.age },
      { id: 'normal', header: t('ranges.columns.normal'), value: text.normal },
      { id: 'critical', header: t('ranges.columns.critical'), value: text.critical },
      { id: 'note', header: t('ranges.columns.note'), value: (row) => row.note ?? '' },
    ],
    [t, text],
  );

  const start = (next: LabRange[] | null) => {
    save.reset();
    setDone(null);
    setConflict('none');
    setExpected(saved.version);
    setEditing(next);
  };

  const submit = async (ranges: LabRange[]) => {
    setDone(null);
    try {
      await save.mutateAsync({ ranges, expectedVersion: expected });
      setEditing(null);
      setConflict('none');
      setDone(t('ranges.saved'));
    } catch (error) {
      if (isApiError(error) && error.serverCode === 'conflict') setConflict('awaiting');
    }
  };

  const code = isApiError(save.error) ? save.error.serverCode : undefined;
  const conflicted = code === 'conflict';

  return (
    <>
      {(conflict !== 'none' || conflicted) && (
        <p role="alert" className="text-sm text-destructive">
          {t('ranges.conflict')}
        </p>
      )}
      {save.isError && !conflicted && (
        <p role="alert" className="text-sm text-destructive">
          {code === 'lab_test_has_no_ranges'
            ? t('ranges.noLonger')
            : tCommon(errorMessageKey(save.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      {editing ? (
        <Editor
          from={editing}
          pending={save.isPending || conflict === 'awaiting'}
          saving={save.isPending}
          onSave={submit}
          onCancel={() => start(null)}
        />
      ) : (
        <>
          <DataGrid
            label={t('ranges.gridLabel')}
            columns={columns}
            rows={rows}
            rowId={(row) => `${row.sex}-${row.ageFromDays}`}
            rowLabel={(row) => `${text.sex(row)}, ${text.age(row)}`}
            status="ready"
            emptyMessage={t('ranges.none')}
          />
          {mayManage && !archived && (
            <Button
              variant="outline"
              className="self-start"
              onClick={() => start(sortRanges(saved.ranges))}
            >
              {t('ranges.edit')}
            </Button>
          )}
          {/* A new check for each saved set: an answer about the old ranges is not kept. */}
          {rows.length > 0 && <Check key={saved.version} labTestId={labTestId} unit={unit} />}
        </>
      )}
    </>
  );
}

/**
 * The reference ranges of a numeric test: what is normal by sex and age, for a manager the form
 * that replaces them, and a check of which range a patient would be read against.
 */
export function Ranges({
  labTestId,
  unit,
  archived,
}: {
  labTestId: string;
  unit: string | undefined;
  archived: boolean;
}) {
  const { t } = useTranslation('lab_tests');
  const { t: tCommon } = useTranslation();
  const ranges = useLabRanges(labTestId, true);
  return (
    <section aria-labelledby="lab-test-ranges" className="flex flex-col gap-3">
      <div className="space-y-1">
        <h2 id="lab-test-ranges" className="text-lg font-semibold">
          {t('ranges.heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('ranges.description')}</p>
      </div>
      {ranges.data ? (
        <Loaded
          labTestId={labTestId}
          unit={unit}
          archived={archived}
          saved={ranges.data}
          refreshFailed={ranges.isError && !ranges.isFetching}
        />
      ) : ranges.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('ranges.loading')}
        </p>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {t('ranges.failed')}
          </p>
          <Button variant="outline" onClick={() => void ranges.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      )}
    </section>
  );
}
