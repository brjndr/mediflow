import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { useInPlaceFormFocus } from '@/shared/hooks/use-in-place-form-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextField,
  useFieldRows,
  useFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useAllergies, useSaveAllergies } from '../hooks/use-triage';
import {
  ALLERGIES_MAX,
  allergiesFormSchema,
  REACTION_MAX,
  blankAllergy,
  SEVERITIES,
  SUBSTANCE_MAX,
  toAllergiesValues,
  toAllergyListUpdate,
  type AllergiesValues,
} from '../schemas';
import type { AllergyList } from '../types';

/** The allergies as saved: never asked, none known, or the list, worst first as recorded. */
function AllergyView({ list }: { list: AllergyList }) {
  const { t } = useTranslation('triage');
  const format = useFormatters();
  return (
    <div className="flex flex-col gap-2">
      {list.status === 'listed' ? (
        <ul className="flex flex-col gap-1">
          {list.items.map((item, index) => (
            <li key={index} className="break-words">
              <span className="font-medium">{item.substance}</span>
              {t(item.reaction ? 'allergies.detailWithReaction' : 'allergies.detail', {
                severity: t(`allergies.severities.${item.severity}`),
                reaction: item.reaction,
              })}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t(list.status === 'none' ? 'allergies.none' : 'allergies.unknown')}</p>
      )}
      {list.updatedAt && list.updatedByName && (
        <p className="text-xs text-muted-foreground">
          {t('allergies.updatedBy', {
            time: format.dateTime(list.updatedAt),
            name: list.updatedByName,
          })}
        </p>
      )}
    </div>
  );
}

/** One group of fields for each allergy, shown while the status is "has allergies". */
function AllergyRows() {
  const { t } = useTranslation('triage');
  const rows = useFieldRows('rows');
  const status = useFieldValue('status');
  const add = useRef<HTMLDivElement>(null);
  // A removed row's button goes with it: focus moves to "Add an allergy".
  const [removed, setRemoved] = useState(0);
  useEffect(() => {
    if (removed > 0) focusIfLost(add.current?.querySelector('button'));
  }, [removed]);
  if (status !== 'listed') return null;
  return (
    <>
      {rows.keys.map((key, index) => {
        const name = (field: string) => `rows.${index}.${field}`;
        return (
          <fieldset key={key} className="flex flex-col gap-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">
              {t('allergies.rowLegend', { number: index + 1 })}
            </legend>
            <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-3">
              <TextField
                name={name('substance')}
                label={t('allergies.substance')}
                required
                maxLength={SUBSTANCE_MAX}
                autoComplete="off"
              />
              <TextField
                name={name('reaction')}
                label={t('allergies.reaction')}
                maxLength={REACTION_MAX}
                autoComplete="off"
              />
              <SelectField
                name={name('severity')}
                label={t('allergies.severity')}
                options={SEVERITIES.map((value) => ({
                  value,
                  label: t(`allergies.severities.${value}`),
                }))}
              />
            </div>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  rows.remove(index);
                  setRemoved((count) => count + 1);
                }}
              >
                {t('allergies.remove', { number: index + 1 })}
              </Button>
            </div>
          </fieldset>
        );
      })}
      <div ref={add}>
        <Button
          type="button"
          variant="outline"
          aria-disabled={rows.keys.length >= ALLERGIES_MAX || undefined}
          onClick={() => {
            if (rows.keys.length < ALLERGIES_MAX) rows.add(blankAllergy);
          }}
        >
          {t('allergies.add')}
        </Button>
        {rows.keys.length >= ALLERGIES_MAX && (
          <p className="text-sm text-muted-foreground">{t('allergies.max')}</p>
        )}
      </div>
    </>
  );
}

function AllergiesForm({
  list,
  conflict,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  list: AllergyList;
  conflict: 'shown' | 'unread' | null;
  pending: boolean;
  error: string | null;
  onSubmit: (values: AllergiesValues) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('triage');
  // Started from what was saved when the form opened; a conflict keeps what was typed.
  const [initial] = useState(() => {
    const values = toAllergiesValues(list);
    return values.status === ''
      ? { ...values, status: 'listed' as const, rows: [blankAllergy] }
      : values;
  });
  const form = useZodForm(allergiesFormSchema, initial);
  return (
    <Form form={form} onSubmit={onSubmit}>
      <SelectField<AllergiesValues>
        name="status"
        label={t('allergies.status')}
        required
        options={[
          { value: 'listed', label: t('allergies.statusListed') },
          { value: 'none', label: t('allergies.statusNone') },
        ]}
      />
      <AllergyRows />
      {conflict === 'shown' && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-destructive p-3 text-sm"
        >
          <p>{t('allergies.conflict')}</p>
          <AllergyView list={list} />
        </div>
      )}
      {conflict === 'unread' && (
        <p role="alert" className="text-sm text-destructive">
          {t('allergies.conflictUnread')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={pending}>
          {pending ? t('allergies.saving') : t('allergies.save')}
        </SubmitButton>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('allergies.cancel')}
        </Button>
      </div>
    </Form>
  );
}

/**
 * The patient's allergies, and for `allergy:update` an Edit form in their place. "Not asked yet"
 * and "No known allergies" are told apart: one is a question still to ask.
 */
export function AllergiesPanel({ patientId }: { patientId: string }) {
  const { t } = useTranslation('triage');
  const { t: tCommon } = useTranslation();
  const canUpdate = usePermission('allergy:update');
  const allergies = useAllergies(patientId);
  const save = useSaveAllergies(patientId);
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useInPlaceFormFocus(editing, box, heading);
  // The version a save is made from: the one the form opened on, then the newest after a conflict.
  const [expected, setExpected] = useState(0);
  // After a conflict: the list as saved now is shown, or it could not be read again.
  const [conflict, setConflict] = useState<'shown' | 'unread' | null>(null);
  // Reading the list again after a conflict; Save waits for it, and only for it.
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const headingId = useId();
  const list = allergies.data;

  const open = () => {
    if (!list) return;
    save.reset();
    setDone(null);
    setConflict(null);
    setExpected(list.version);
    setEditing(true);
  };

  const submit = async (values: AllergiesValues) => {
    setDone(null);
    try {
      await save.mutateAsync(toAllergyListUpdate(values, expected));
      setEditing(false);
      setConflict(null);
      setDone(t('allergies.saved'));
    } catch (error) {
      if (!(isApiError(error) && error.serverCode === 'conflict')) return;
      // The form keeps what was typed; the next save is made from the newest version. When it
      // cannot be read, the version stays and the next save asks again.
      setChecking(true);
      const fresh = await allergies.refetch();
      setChecking(false);
      if (fresh.data && !fresh.isError) {
        setExpected(fresh.data.version);
        setConflict('shown');
      } else {
        setConflict('unread');
      }
    }
  };

  const failure =
    save.isError && !(isApiError(save.error) && save.error.serverCode === 'conflict')
      ? tCommon(errorMessageKey(save.error))
      : null;

  return (
    <section ref={box} aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} ref={heading} tabIndex={-1} className="text-lg font-semibold">
          {t('allergies.heading')}
        </h2>
        {canUpdate && list && !editing && (
          <Button type="button" variant="outline" size="sm" data-opens="edit" onClick={open}>
            {list.status === 'unknown' ? t('allergies.record') : t('allergies.edit')}
          </Button>
        )}
      </div>
      {/* Always on the page, so what was done is read out. */}
      <p role="status" className="text-sm empty:hidden">
        {done}
      </p>
      {allergies.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : allergies.isError && !list ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(allergies.error))}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void allergies.refetch()}
          >
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : list && editing ? (
        <AllergiesForm
          list={list}
          conflict={conflict}
          pending={save.isPending || checking}
          error={failure}
          onSubmit={(values) => void submit(values)}
          onCancel={() => {
            save.reset();
            setEditing(false);
          }}
        />
      ) : list ? (
        <AllergyView list={list} />
      ) : null}
    </section>
  );
}
