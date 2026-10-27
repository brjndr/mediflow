import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useFeatureFlag, usePermission } from '@/access';
import { DrugSearch, useMedicineName } from '@/features/drugs';
import { useLocations } from '@/features/inventory';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useFieldRows, useZodForm } from '@/shared/ui/form';
import { todayIn } from '@/shared/utils';
import { useFormatters, useTenant } from '@/tenancy';
import { PharmacyLinks } from '../components/PharmacyLinks';
import { useCreateSale, useSaleItemOptions } from '../hooks/use-sales';
import {
  createSaleFormSchema,
  missingPrescription,
  PRESCRIBER_NAME_MAX,
  PRESCRIBER_REGISTRATION_MAX,
  SALE_ITEMS_MAX,
  sellableUnits,
  takeFromBatches,
  type SaleFormValues,
} from '../sales-schemas';
import type { SaleCreate, SaleItemOptions } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

const useSaleForm = (schema: ReturnType<typeof createSaleFormSchema>) =>
  useZodForm<SaleFormValues, SaleFormValues>(schema, {
    lines: [],
    prescriberName: '',
    prescriberRegistration: '',
    prescribedOn: '',
  });
type SaleForm = ReturnType<typeof useSaleForm>;

/** Refusals in words of their own. */
const REFUSED: Record<string, string> = {
  prescription_required: 'sale.refused.prescription',
  unknown_patient: 'sale.refused.patient',
  no_price: 'sale.refused.noPrice',
  insufficient_stock: 'sale.refused.insufficient',
  batch_expired: 'sale.refused.expired',
  unknown_location: 'sale.refused.place',
  unknown_batch: 'sale.refused.batch',
  unknown_item: 'sale.refused.item',
};

/**
 * A counter sale (`pharmacy/sales/new`, #101), for `sale:create`: the place to sell from, the
 * items with their units, taken from the batches in date with a price nearest expiry first, and
 * who it is for. An over-the-counter sale may name nobody; an item of schedule H, H1, X, narcotic
 * or controlled needs a registered patient and the outside prescription it is sold against
 * (prescriber, registration number, date). The sale opens once recorded. Works at every width.
 */
export default function NewSale() {
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const nameOf = useMedicineName();

  // The places are inventory's: read only by whoever may, with inventory switched on.
  const mayReadStock = usePermission('stock:read');
  const inventoryOn = useFeatureFlag('inventory');
  const canSeePlaces = mayReadStock && inventoryOn;
  const placeList = useLocations(false, canSeePlaces);
  const places = useMemo(
    () => placeList.data?.pages.flatMap((page) => page.items) ?? [],
    [placeList.data],
  );
  const placeFieldId = useId();
  const [chosenPlace, setChosenPlace] = useState('');
  const locationId =
    chosenPlace || (places.find((place) => place.kind === 'pharmacy') ?? places[0])?.id || '';

  const [patient, setPatient] = useState<PatientSummary | null>(null);
  // Focus follows a patient chosen (to Change) or let go (to the search), never left on the page.
  const [searchAfresh, setSearchAfresh] = useState(false);
  const patientChosen = useRef(false);
  const patientBox = useRef<HTMLDivElement>(null);
  const patientErrorId = useId();
  const [patientError, setPatientError] = useState(false);
  useLayoutEffect(() => {
    if (!patientChosen.current || !patient) return;
    patientChosen.current = false;
    patientBox.current?.querySelector('button')?.focus();
  }, [patient]);

  const today = todayIn(timezone);
  const schema = useMemo(() => createSaleFormSchema(today), [today]);
  const form = useSaleForm(schema);
  const lines = form.watch('lines');
  const drugIds = useMemo(() => lines.map((line) => line.drugId), [lines]);
  const optionQueries = useSaleItemOptions(drugIds, locationId);
  const optionsOf = (index: number): SaleItemOptions | undefined => optionQueries[index]?.data;
  const needsPrescription = optionQueries.some((query) => query.data?.needsPrescription);

  const sale = useCreateSale();
  const code = isApiError(sale.error) ? sale.error.serverCode : undefined;
  const failure = sale.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(sale.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const submit = async (values: SaleFormValues) => {
    if (optionQueries.some((query) => query.isError)) {
      // An item whose stock could not be read is retried from its own row.
      say(t('sale.form.readFailed'));
      return;
    }
    if (optionQueries.some((query) => !query.data)) {
      say(t('sale.form.stillReading'));
      return;
    }
    // A prescription is of a patient, needed or not; the cart's needs are known only now.
    const missing = needsPrescription ? missingPrescription(values) : [];
    missing.forEach((name, index) =>
      form.setError(
        name,
        { message: 'pharmacy:sale.form.prescriptionNeeded' },
        { shouldFocus: index === 0 && patient !== null },
      ),
    );
    if ((needsPrescription || values.prescriberName !== '') && !patient) {
      setPatientError(true);
      patientBox.current?.querySelector<HTMLElement>('input, button')?.focus();
      return;
    }
    if (missing.length > 0) return;
    const body: SaleCreate = {
      locationId,
      ...(patient ? { patientId: patient.id } : {}),
      ...(values.prescriberName !== ''
        ? {
            prescriberName: values.prescriberName,
            prescriberRegistration: values.prescriberRegistration,
            prescribedOn: values.prescribedOn,
          }
        : {}),
      lines: [],
    };
    for (const [index, line] of values.lines.entries()) {
      const taken = takeFromBatches(optionsOf(index)?.batches ?? [], Number(line.units));
      if (!taken) {
        form.setError(
          `lines.${index}.units`,
          { message: 'pharmacy:sale.form.notEnough' },
          { shouldFocus: true },
        );
        return;
      }
      body.lines.push({
        drugId: line.drugId,
        batches: taken.map(({ batchId, quantity }) => ({ batchId, quantity })),
      });
    }
    sale.reset();
    try {
      const sold = await sale.mutateAsync(body);
      navigate(`/pharmacy/sales/${sold.id}`, { state: { sold: true } });
    } catch {
      // Said from the mutation state; the batches are read again.
    }
  };

  let total = 0;
  lines.forEach((line, index) => {
    const taken = takeFromBatches(optionsOf(index)?.batches ?? [], Number(line.units) || 0);
    total += taken?.reduce((sum, each) => sum + each.quantity * each.priceMinor, 0) ?? 0;
  });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <PharmacyLinks />
      <h1 className="text-2xl font-semibold tracking-tight">{t('sale.heading')}</h1>
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none"
      >
        {message.text}
      </p>
      <div className="flex flex-col gap-1.5 md:max-w-sm">
        {canSeePlaces && places.length > 0 ? (
          <label htmlFor={placeFieldId} className="text-sm font-medium">
            {t('sale.place')}
          </label>
        ) : (
          <p className="text-sm font-medium">{t('sale.place')}</p>
        )}
        {canSeePlaces && placeList.isPending ? (
          <p className="text-sm text-muted-foreground">{t('detail.placesLoading')}</p>
        ) : canSeePlaces && placeList.isError ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(placeList.error))}
            </p>
            <Button type="button" variant="outline" onClick={() => void placeList.refetch()}>
              {t('retry')}
            </Button>
          </div>
        ) : canSeePlaces && places.length > 0 ? (
          <select
            id={placeFieldId}
            className={field}
            value={locationId}
            onChange={(event) => setChosenPlace(event.target.value)}
          >
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm">{t(canSeePlaces ? 'detail.noPlaces' : 'sale.placesHidden')}</p>
        )}
      </div>

      {locationId !== '' && (
        <Form form={form} onSubmit={submit} className="flex flex-col gap-4">
          <Cart
            form={form}
            optionsOf={optionsOf}
            queries={optionQueries}
            nameOf={nameOf}
            onSay={say}
            onRetry={(index) => void optionQueries[index]?.refetch()}
          />

          <section className="flex flex-col gap-3" aria-labelledby={`${placeFieldId}-patient`}>
            <h2 id={`${placeFieldId}-patient`} className="font-semibold">
              {t(needsPrescription ? 'sale.patientNeeded' : 'sale.patientOptional')}
            </h2>
            <div ref={patientBox} className="flex flex-col gap-1.5">
              {patient ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                  <div className="min-w-0">
                    <p className="break-words font-medium">
                      {patient.firstName} {patient.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('sale.patientMrn', { mrn: patient.mrn })}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setPatient(null);
                      setSearchAfresh(true);
                    }}
                  >
                    {t('sale.changePatient')}
                  </Button>
                </div>
              ) : (
                <PatientSearch
                  label={t('sale.patient')}
                  onSelect={(next) => {
                    patientChosen.current = true;
                    setPatient(next);
                    setPatientError(false);
                  }}
                  describedBy={patientError ? patientErrorId : undefined}
                  focusOnMount={searchAfresh}
                  required={needsPrescription}
                />
              )}
              {patientError && !patient && (
                <p id={patientErrorId} role="alert" className="text-sm text-destructive">
                  {t(
                    needsPrescription
                      ? 'sale.form.patientNeeded'
                      : 'sale.form.patientForPrescription',
                  )}
                </p>
              )}
            </div>
            <h2 className="font-semibold">
              {t(needsPrescription ? 'sale.prescriptionNeeded' : 'sale.prescriptionOptional')}
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <TextField
                name="prescriberName"
                label={t('sale.prescriberName')}
                required={needsPrescription}
                maxLength={PRESCRIBER_NAME_MAX}
                autoComplete="off"
              />
              <TextField
                name="prescriberRegistration"
                label={t('sale.prescriberRegistration')}
                required={needsPrescription}
                maxLength={PRESCRIBER_REGISTRATION_MAX}
                autoComplete="off"
              />
              <TextField
                name="prescribedOn"
                type="date"
                label={t('sale.prescribedOn')}
                required={needsPrescription}
                max={today}
              />
            </div>
          </section>

          <p className="text-lg font-semibold">{t('sale.total', { total: format.money(total) })}</p>
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
          <div>
            <SubmitButton pending={sale.isPending}>
              {sale.isPending ? t('sale.submitting') : t('sale.submit')}
            </SubmitButton>
          </div>
        </Form>
      )}
    </div>
  );
}

/**
 * The cart, a row per item: its units, what they are taken from and cost, and Remove; then the
 * search to add another. Focus goes to a new row's units, and to the search when a row is removed.
 */
function Cart({
  form,
  optionsOf,
  queries,
  nameOf,
  onSay,
  onRetry,
}: {
  form: SaleForm;
  optionsOf: (index: number) => SaleItemOptions | undefined;
  queries: ReturnType<typeof useSaleItemOptions>;
  nameOf: ReturnType<typeof useMedicineName>;
  onSay: (text: string) => void;
  onRetry: (index: number) => void;
}) {
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const rows = useFieldRows('lines');
  const lines = form.watch('lines');
  const search = useRef<HTMLDivElement>(null);
  // Where focus goes once the rows have changed: a new row's units, or the search.
  const focusNext = useRef<number | 'search' | null>(null);
  const count = rows.keys.length;
  useLayoutEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === 'search') search.current?.querySelector('input')?.focus();
    else if (next !== null) form.setFocus(`lines.${next}.units`);
  }, [count, form]);
  const cartError = form.formState.errors.lines?.message;
  const cartErrorId = useId();
  // Sent with nothing in it: the search, said to be in error, takes focus.
  useLayoutEffect(() => {
    if (cartError) search.current?.querySelector('input')?.focus();
  }, [cartError]);

  return (
    <section className="flex flex-col gap-3" aria-label={t('sale.cart')}>
      <h2 className="font-semibold">{t('sale.cart')}</h2>
      {rows.keys.length === 0 && <p className="text-sm text-muted-foreground">{t('sale.empty')}</p>}
      <ul className="flex flex-col gap-3">
        {rows.keys.map((key, index) => {
          const line = lines[index];
          const query = queries[index];
          const options = optionsOf(index);
          const units = Number(line?.units) || 0;
          const taken = options ? takeFromBatches(options.batches, units) : null;
          const cost = taken?.reduce((sum, each) => sum + each.quantity * each.priceMinor, 0);
          return (
            <li key={key} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-words font-medium">{line?.name}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('sale.remove', { name: line?.name })}
                  onClick={() => {
                    focusNext.current = 'search';
                    rows.remove(index);
                  }}
                >
                  {t('sale.removeShort')}
                </Button>
              </div>
              {/* There at once, so focus can go to it while the item's stock is read. */}
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <TextField
                  name={`lines.${index}.units`}
                  label={t('sale.units', { name: line?.name })}
                  hint={
                    options
                      ? t('sale.unitsHint', { count: sellableUnits(options.batches) })
                      : undefined
                  }
                  inputMode="numeric"
                  autoComplete="off"
                  required
                />
              </div>
              {query?.isPending ? (
                <p className="text-sm text-muted-foreground">{t('sale.loadingItem')}</p>
              ) : query?.isError ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p role="alert" className="text-sm text-destructive">
                    {tCommon(errorMessageKey(query.error))}
                  </p>
                  <Button type="button" variant="outline" onClick={() => onRetry(index)}>
                    {t('retry')}
                  </Button>
                </div>
              ) : options ? (
                <>
                  {(options.needsPrescription || options.inRegister) && (
                    <p className="text-sm">
                      {[
                        options.needsPrescription ? t('sale.needsPrescription') : '',
                        options.inRegister ? t('sale.inRegister') : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    </p>
                  )}
                  {taken && taken.length > 0 && (
                    <ul className="text-sm text-muted-foreground">
                      {taken.map((each) => {
                        const batch = options.batches.find((b) => b.batchId === each.batchId);
                        return (
                          <li key={each.batchId}>
                            {t('sale.fromBatch', {
                              count: each.quantity,
                              number: batch?.batchNumber,
                              expiry: batch ? format.calendarDate(batch.expiryDate) : '',
                              price: format.money(each.priceMinor),
                            })}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {cost !== undefined && (
                    <p className="text-sm font-medium">
                      {t('sale.lineTotal', { total: format.money(cost) })}
                    </p>
                  )}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {cartError && (
        <p id={cartErrorId} role="alert" className="text-sm text-destructive">
          {t(cartError)}
        </p>
      )}
      {rows.keys.length < SALE_ITEMS_MAX ? (
        <div ref={search}>
          <DrugSearch
            label={t('sale.add')}
            includeConsumables
            invalid={cartError !== undefined}
            describedBy={cartError ? cartErrorId : undefined}
            onSelect={(drug) => {
              const at = lines.findIndex((each) => each.drugId === drug.id);
              if (at >= 0) {
                onSay(t('sale.alreadyInCart', { name: nameOf(drug) }));
                form.setFocus(`lines.${at}.units`);
                return;
              }
              focusNext.current = lines.length;
              rows.add({ drugId: drug.id, name: nameOf(drug), units: '1' });
              form.clearErrors('lines');
            }}
          />
        </div>
      ) : (
        <p className="text-sm">{t('sale.cartFull', { count: SALE_ITEMS_MAX })}</p>
      )}
    </section>
  );
}
