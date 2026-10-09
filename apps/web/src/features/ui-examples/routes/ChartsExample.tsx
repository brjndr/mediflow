import { useTranslation } from 'react-i18next';
import { CategoryBarChart, TimeSeriesChart } from '@/shared/ui/charts';
import { useFormatters } from '@/tenancy';
import { ExamplePage } from '../components/ExamplePage';

// Synthetic figures. A real screen gets these from a report endpoint.
const VISITS = [112, 134, 98, 151, 143, 87, 64, 120, 139, 156, 148, 131, 92, 71];
const FIRST_DAY = Date.UTC(2026, 9, 1);
const DAY_MS = 86_400_000;
const BY_DEPARTMENT = [
  ['cardiology', 412],
  ['neurology', 268],
  ['orthopaedics', 351],
  ['paediatrics', 505],
] as const;

export default function ChartsExample() {
  const { t } = useTranslation('ui_examples');
  const format = useFormatters();

  return (
    <ExamplePage heading={t('charts.heading')}>
      <section aria-labelledby="visits-title" className="rounded-lg border p-4">
        <h2 id="visits-title" className="mb-3 text-sm font-medium">
          {t('charts.visitsTitle')}
        </h2>
        <TimeSeriesChart
          title={t('charts.visitsTitle')}
          labelHeader={t('charts.day')}
          valueHeader={t('charts.visits')}
          // Dates and numbers are formatted for the hospital, as everywhere else.
          data={VISITS.map((value, index) => ({
            label: format.date(FIRST_DAY + index * DAY_MS),
            value,
          }))}
          formatValue={format.number}
        />
      </section>
      <section aria-labelledby="departments-title" className="rounded-lg border p-4">
        <h2 id="departments-title" className="mb-3 text-sm font-medium">
          {t('charts.departmentsTitle')}
        </h2>
        <CategoryBarChart
          title={t('charts.departmentsTitle')}
          labelHeader={t('charts.department')}
          valueHeader={t('charts.visits')}
          data={BY_DEPARTMENT.map(([department, value]) => ({
            label: t(`departments.${department}`),
            value,
          }))}
          formatValue={format.number}
        />
      </section>
    </ExamplePage>
  );
}
