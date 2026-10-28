import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { DrugSearch, useMedicineName } from '@/features/drugs';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button, buttonVariants } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextField,
  useFieldRows,
  useZodForm,
} from '@/shared/ui/form';
import { INDENT_REFUSED } from '../components/refusals';
import { useCreateIndent, useIndentPlaces } from '../hooks/use-indents';
import { INDENT_LINES_MAX, indentFormSchema, NOTE_MAX, type IndentFormValues } from '../schemas';

const useIndentForm = () =>
  useZodForm<IndentFormValues, IndentFormValues>(indentFormSchema, {
    fromLocationId: '',
    toLocationId: '',
    note: '',
    lines: [],
  });
type IndentForm = ReturnType<typeof useIndentForm>;

/**
 * A new indent (`inventory/indents/new`, #105), for `indent:create`: the place that asks, the
 * store asked (the places in use), a note, and its lines, each an item added with the drug search
 * (medicines and consumables) and its units. Saving opens the indent. Works at every width.
 */
export default function IndentEditor() {
  const { t } = useTranslation('indents');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const form = useIndentForm();
  const places = useIndentPlaces();
  const placeOptions = (places.data?.items ?? []).map((place) => ({
    value: place.id,
    label: place.name,
  }));
  // Only a store is asked (the API refuses another place).
  const storeOptions = (places.data?.items ?? [])
    .filter((place) => place.kind === 'store')
    .map((place) => ({ value: place.id, label: place.name }));

  const create = useCreateIndent();
  const code = isApiError(create.error) ? create.error.serverCode : undefined;
  const failure = create.error
    ? code !== undefined && INDENT_REFUSED[code]
      ? t(INDENT_REFUSED[code])
      : tCommon(errorMessageKey(create.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: IndentFormValues) => {
    create.reset();
    try {
      const saved = await create.mutateAsync({
        fromLocationId: values.fromLocationId,
        toLocationId: values.toLocationId,
        ...(values.note === '' ? {} : { note: values.note }),
        lines: values.lines.map((line) => ({
          drugId: line.drugId,
          quantity: Number(line.quantity),
        })),
      });
      navigate(`/inventory/indents/${saved.id}`, { state: { saved: true } });
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('form.heading')}</h1>
      <Form form={form} onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <SelectField
            name="fromLocationId"
            label={t('form.from')}
            hint={t('form.fromHint')}
            required
            placeholder={t(places.isPending ? 'form.loadingPlaces' : 'form.choosePlace')}
            options={placeOptions}
          />
          <SelectField
            name="toLocationId"
            label={t('form.to')}
            hint={t('form.toHint')}
            required
            placeholder={t(places.isPending ? 'form.loadingPlaces' : 'form.chooseStore')}
            options={storeOptions}
          />
          <TextField name="note" label={t('form.note')} maxLength={NOTE_MAX} autoComplete="off" />
        </div>
        {places.isError && (
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(places.error))}
          </p>
        )}
        <IndentLines form={form} />
        {failure && (
          <p
            ref={alert}
            role="alert"
            tabIndex={-1}
            className="text-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={create.isPending}>
            {create.isPending ? t('form.saving') : t('form.save')}
          </SubmitButton>
          <Link to="/inventory/indents" className={buttonVariants({ variant: 'outline' })}>
            {t('form.cancel')}
          </Link>
        </div>
      </Form>
    </div>
  );
}

/**
 * The lines, a row per item with its units and Remove; then the search to add another. Focus goes
 * to a new row's units, and to the search when a row is removed.
 */
function IndentLines({ form }: { form: IndentForm }) {
  const { t } = useTranslation('indents');
  const nameOf = useMedicineName();
  const rows = useFieldRows('lines');
  const lines = form.watch('lines');
  const search = useRef<HTMLDivElement>(null);
  const focusNext = useRef<number | 'search' | null>(null);
  const [notice, setNotice] = useState('');
  const count = rows.keys.length;
  useLayoutEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === 'search') search.current?.querySelector('input')?.focus();
    else if (next !== null) form.setFocus(`lines.${next}.quantity`);
  }, [count, form]);
  const linesError = form.formState.errors.lines?.message;
  const headingId = useId();
  const linesErrorId = useId();
  useLayoutEffect(() => {
    if (linesError) search.current?.querySelector('input')?.focus();
  }, [linesError]);

  return (
    <section className="flex flex-col gap-3" aria-labelledby={headingId}>
      <h2 id={headingId} className="font-semibold">
        {t('form.lines')}
      </h2>
      {count === 0 && <p className="text-sm text-muted-foreground">{t('form.noLinesYet')}</p>}
      <ul className="flex flex-col gap-3">
        {rows.keys.map((key, index) => {
          const line = lines[index];
          return (
            <li
              key={key}
              className="flex flex-col gap-2 rounded-md border p-3 md:flex-row md:items-end"
            >
              <p className="min-w-0 break-words font-medium md:flex-1 md:self-center">
                {line?.name}
              </p>
              <div className="md:w-48">
                <TextField
                  name={`lines.${index}.quantity`}
                  label={t('form.units', { name: line?.name })}
                  inputMode="numeric"
                  autoComplete="off"
                  required
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t('form.remove', { name: line?.name })}
                onClick={() => {
                  focusNext.current = 'search';
                  rows.remove(index);
                }}
              >
                {t('form.removeShort')}
              </Button>
            </li>
          );
        })}
      </ul>
      {linesError && (
        <p id={linesErrorId} role="alert" className="text-sm text-destructive">
          {t(linesError)}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {notice}
      </p>
      {count < INDENT_LINES_MAX ? (
        <div ref={search}>
          <DrugSearch
            label={t('form.add')}
            includeConsumables
            invalid={linesError !== undefined}
            describedBy={linesError ? linesErrorId : undefined}
            onSelect={(drug) => {
              const at = lines.findIndex((each) => each.drugId === drug.id);
              if (at >= 0) {
                setNotice(t('form.alreadyThere', { name: nameOf(drug) }));
                form.setFocus(`lines.${at}.quantity`);
                return;
              }
              setNotice('');
              focusNext.current = lines.length;
              rows.add({ drugId: drug.id, name: nameOf(drug), quantity: '' });
              form.clearErrors('lines');
            }}
          />
        </div>
      ) : (
        <p className="text-sm">{t('form.full', { count: INDENT_LINES_MAX })}</p>
      )}
    </section>
  );
}
