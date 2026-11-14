import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { StatusBadge } from '@/shared/ui/status-badge';
import { useFormatters } from '@/tenancy';
import { useCompatibleUnits } from '../hooks/use-blood';
import { BLOOD_COMPONENTS } from '../schemas';
import type { BloodComponent, CompatibleUnit } from '../types';
import { refusalKey } from './refusal';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

function CrossmatchBadge({ item }: { item: CompatibleUnit }) {
  const { t } = useTranslation('blood-bank');
  const format = useFormatters();
  const { crossmatch } = item;
  if (item.crossmatchValid && crossmatch) {
    return (
      <StatusBadge
        tone="success"
        label={t('panel.matched', { until: format.dateTime(crossmatch.validUntil) })}
      />
    );
  }
  if (crossmatch?.result === 'incompatible') {
    return <StatusBadge tone="danger" label={t('panel.incompatible')} />;
  }
  if (crossmatch) return <StatusBadge tone="warning" label={t('panel.expired')} />;
  return <StatusBadge tone="neutral" label={t('panel.notMatched')} />;
}

/**
 * The units on the shelf that fit one patient, soonest expiry first, with the cross-match each
 * already has. The fit is the server's answer (the ABO rule is not repeated here).
 */
export function CompatiblePanel() {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [component, setComponent] = useState<BloodComponent>('red_cells');
  // The patient's group is a field of its own: shown only to those who may read it.
  const seesGroup = usePermission('patient.bloodGroup:read');
  const found = useCompatibleUnits(patient?.id, component);
  const refused = found.isError ? refusalKey(found.error) : null;

  return (
    <section aria-labelledby="blood-compatible" className="flex flex-col gap-3">
      <h2 id="blood-compatible" className="text-lg font-semibold">
        {t('panel.heading')}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          {patient ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm">
                {t('reserve.chosen', { name: `${patient.firstName} ${patient.lastName}` })}
              </p>
              <Button type="button" variant="outline" onClick={() => setPatient(null)}>
                {t('reserve.change')}
              </Button>
            </div>
          ) : (
            <PatientSearch label={t('panel.patient')} onSelect={setPatient} />
          )}
        </div>
        <label className="flex min-w-40 flex-col gap-1 text-sm font-medium">
          {t('filters.component')}
          <select
            value={component}
            onChange={(event) => setComponent(event.target.value as BloodComponent)}
            className={control}
          >
            {BLOOD_COMPONENTS.map((value) => (
              <option key={value} value={value}>
                {t(`component.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* Always on the page, so what the search found is read out. */}
      <p aria-live="polite" className="text-sm empty:sr-only">
        {!patient || found.isPending || found.isError
          ? ''
          : found.data.items.length === 0
            ? t(seesGroup ? 'panel.none' : 'panel.noneNoGroup', {
                group: found.data.patientBloodGroup,
              })
            : t(seesGroup ? 'panel.count' : 'panel.countNoGroup', {
                count: found.data.items.length,
                group: found.data.patientBloodGroup,
              })}
      </p>
      {found.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(found.error))}
        </p>
      )}
      {found.data && found.data.items.length > 0 && (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {found.data.items.map((item) => (
            <li key={item.unit.id} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
              <p className="font-medium">
                {item.unit.unitNumber} - {item.unit.bloodGroup}{' '}
                {t(`component.${item.unit.component}`)}
              </p>
              <p className="text-muted-foreground">
                {t('panel.expires', { date: format.dateTime(item.unit.expiresAt) })}
              </p>
              <div>
                <CrossmatchBadge item={item} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
