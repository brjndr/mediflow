import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useFeatureFlag, usePermission } from '@/access';
import { useLocations } from '@/features/inventory';
import { useAllergies } from '@/features/triage';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { DispensePanel, type AllergyCheck } from '../components/DispensePanel';
import { DispenseSlip } from '../components/DispenseSlip';
import { useCompleteLine, usePrescription, usePrintSlip } from '../hooks/use-pharmacy';
import { isOpen, remainingOf } from '../schemas';
import type { PharmacyLine } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

const COMPLETE_REFUSED: Record<string, string> = {
  conflict: 'complete.refused.conflict',
  invalid_transition: 'complete.refused.closed',
  order_not_found: 'dispense.refused.gone',
};

/** The patient's allergies for the warning: the list when readable, else why it is not. */
function useDispensingAllergies(patientId: string): AllergyCheck {
  const allowed = usePermission('allergy:read');
  const switchedOn = useFeatureFlag('triage');
  const list = useAllergies(patientId, { enabled: allowed && switchedOn && patientId !== '' });
  if (!allowed || !switchedOn) return { substances: [], notice: 'allergies.hidden' };
  if (list.isPending) return { substances: [], notice: 'allergies.loading' };
  if (list.isError) return { substances: [], notice: 'allergies.failed' };
  if (list.data.status === 'unknown') return { substances: [], notice: 'allergies.unknown' };
  return { substances: list.data.items.map((each) => each.substance) };
}

/**
 * A prescription at the pharmacy (`pharmacy/prescriptions/:id`, #100), for `dispense:read`: who it
 * is for and their allergies, the place to dispense from, its lines with what is left to give,
 * and its dispenses, each with its slip to print. `dispense:create` dispenses a line (a panel in
 * place) and completes one in progress when nothing more will be given. Works at every width.
 */
export default function DispensePrescription() {
  const { prescriptionId = '' } = useParams();
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const prescription = usePrescription(prescriptionId);
  const rx = prescription.data;
  const allergies = useDispensingAllergies(rx?.patientId ?? '');
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

  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);
  const [panel, setPanel] = useState<PharmacyLine | null>(null);
  usePanelFocus(panel ? panel.orderId : null, box, status);
  const complete = useCompleteLine(prescriptionId);
  const printing = usePrintSlip();
  const printErrorId = useId();

  const lineWords = (line: PharmacyLine) => {
    if (line.status === 'cancelled') {
      return t('lines.status.cancelled', { reason: line.cancelReason ?? '' });
    }
    if (line.status === 'completed') return t('lines.status.completed');
    return t(line.status === 'in_progress' ? 'lines.status.partly' : 'lines.status.open');
  };

  const columns = useMemo<GridColumn<PharmacyLine>[]>(
    () => [
      {
        id: 'item',
        header: t('lines.columns.item'),
        value: (row) => row.itemName,
        hideable: false,
      },
      {
        id: 'dosage',
        header: t('lines.columns.dosage'),
        value: (row) =>
          [
            t('dispense.dosage', { dose: row.dose, frequency: row.frequency }),
            t(`route.${row.route}`),
            row.durationDays === undefined ? '' : t('detail.days', { count: row.durationDays }),
            row.instructions ?? '',
          ]
            .filter(Boolean)
            .join(', '),
      },
      {
        id: 'quantity',
        header: t('lines.columns.quantity'),
        value: (row) =>
          row.quantity === undefined
            ? t('lines.noQuantity')
            : t('lines.units', { count: row.quantity }),
      },
      {
        id: 'given',
        header: t('lines.columns.given'),
        value: (row) => t('lines.units', { count: row.dispensedQuantity }),
      },
      { id: 'status', header: t('lines.columns.status'), value: lineWords },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lineWords reads only t
    [t],
  );

  const actions: GridAction<PharmacyLine>[] = [
    {
      id: 'dispense',
      label: t('lines.dispense'),
      requires: 'dispense:create',
      disabled: (row) => !isOpen(row) || remainingOf(row) === 0 || locationId === '',
      onSelect: (row) => {
        if (isOpen(row) && remainingOf(row) !== 0 && locationId !== '') setPanel(row);
      },
    },
    {
      id: 'complete',
      label: t('lines.complete'),
      requires: 'dispense:create',
      disabled: (row) => row.status !== 'in_progress' || complete.isPending,
      onSelect: (row) => {
        if (row.status !== 'in_progress' || complete.isPending) return;
        complete.mutate(row, {
          onSuccess: () => say(t('complete.done', { item: row.itemName })),
          onError: (error) => {
            const key = isApiError(error) ? COMPLETE_REFUSED[error.serverCode ?? ''] : undefined;
            say(key ? t(key) : tCommon(errorMessageKey(error)));
          },
        });
      },
    },
  ];

  if (prescription.isPending) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{t('detail.loading')}</p>;
  }
  // A failed read again after a dispense keeps what is on the screen and says so below.
  if (!rx) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('detail.heading')}</h1>
        <p role="alert" className="text-sm text-destructive">
          {isApiError(prescription.error) &&
          prescription.error.serverCode === 'prescription_not_found'
            ? t('detail.notFound')
            : tCommon(errorMessageKey(prescription.error))}
        </p>
        <Link to="/pharmacy" className="text-sm underline underline-offset-4">
          {t('detail.back')}
        </Link>
      </div>
    );
  }

  const lineOf = (orderId: string) => rx.lines.find((each) => each.orderId === orderId);

  return (
    <div ref={box} className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <Link
        to="/pharmacy"
        className="self-start rounded-sm text-sm underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
      >
        {t('detail.back')}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{t('detail.heading')}</h1>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-[auto_1fr]">
        <dt className="font-medium">{t('slip.patient')}</dt>
        <dd>{t('detail.patient', { name: rx.patientName, mrn: maskMrn(rx.patientMrn) })}</dd>
        <dt className="font-medium">{t('slip.prescribedBy')}</dt>
        <dd>
          {t('detail.prescribedBy', {
            name: rx.prescribedByName,
            time: format.dateTime(rx.prescribedAt),
          })}
        </dd>
        <dt className="font-medium">{t('detail.allergies')}</dt>
        <dd>
          {allergies.notice
            ? t(allergies.notice)
            : allergies.substances.length > 0
              ? allergies.substances.join(', ')
              : t('allergies.none')}
        </dd>
        {rx.advice && (
          <>
            <dt className="font-medium">{t('slip.advice')}</dt>
            <dd className="whitespace-pre-line">{rx.advice}</dd>
          </>
        )}
      </dl>
      {rx.replacedById && <p className="text-sm font-medium">{t('detail.replaced')}</p>}
      {prescription.isError && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {t('detail.refreshFailed')}
          </p>
          <Button type="button" variant="outline" onClick={() => void prescription.refetch()}>
            {t('retry')}
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-1.5 md:max-w-sm">
        {canSeePlaces && places.length > 0 ? (
          <label htmlFor={placeFieldId} className="text-sm font-medium">
            {t('detail.place')}
          </label>
        ) : (
          <p className="text-sm font-medium">{t('detail.place')}</p>
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
            onChange={(event) => {
              setChosenPlace(event.target.value);
              setPanel(null);
            }}
          >
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm">{t(canSeePlaces ? 'detail.noPlaces' : 'detail.placesHidden')}</p>
        )}
      </div>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message.text}
      </p>
      {panel && (
        <DispensePanel
          key={`${panel.orderId}:${locationId}`}
          prescription={rx}
          line={lineOf(panel.orderId) ?? panel}
          locationId={locationId}
          allergies={allergies}
          onClose={() => setPanel(null)}
          onDispensed={(dispense) => {
            setPanel(null);
            say(t('dispense.done', { item: dispense.itemName, count: dispense.quantity }));
          }}
        />
      )}
      <DataGrid
        label={t('lines.heading')}
        columns={columns}
        rows={rx.lines}
        rowId={(row) => row.orderId}
        rowLabel={(row) => row.itemName}
        actions={actions}
        status="ready"
        emptyMessage={t('lines.empty')}
      />
      <section aria-labelledby={`${placeFieldId}-dispenses`} className="flex flex-col gap-2">
        <h2 id={`${placeFieldId}-dispenses`} className="text-lg font-semibold">
          {t('dispenses.heading')}
        </h2>
        {printing.error && (
          <p id={printErrorId} role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(printing.error))}
          </p>
        )}
        {rx.dispenses.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dispenses.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rx.dispenses.map((dispense) => (
              <li key={dispense.id} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
                <p className="font-medium">
                  {t('slip.item', { item: dispense.itemName, count: dispense.quantity })}
                </p>
                {dispense.substitutionReason && (
                  <p>{t('dispenses.substitute', { reason: dispense.substitutionReason })}</p>
                )}
                <p>
                  {dispense.batches
                    .map((batch) =>
                      t('slip.batch', {
                        number: batch.batchNumber,
                        expiry: format.calendarDate(batch.expiryDate),
                        count: batch.quantity,
                      }),
                    )
                    .join('; ')}
                </p>
                <p className="text-muted-foreground">
                  {t('dispenses.by', {
                    name: dispense.dispensedByName,
                    time: format.dateTime(dispense.dispensedAt),
                    place: dispense.locationName,
                  })}
                </p>
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={t('dispenses.printLabel', { item: dispense.itemName })}
                    aria-disabled={printing.busy || undefined}
                    aria-describedby={printing.error ? printErrorId : undefined}
                    onClick={() => {
                      if (!printing.busy) printing.print(dispense);
                    }}
                  >
                    {t('dispenses.print')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {printing.job && (
        <PrintSheet key={printing.job.id} onDone={printing.done}>
          <DispenseSlip
            prescription={rx}
            line={lineOf(printing.job.dispense.orderId)}
            dispense={printing.job.dispense}
          />
        </PrintSheet>
      )}
    </div>
  );
}
