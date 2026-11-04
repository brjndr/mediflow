import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import {
  Form,
  SelectField,
  SubmitButton,
  TextField,
  useFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { REPORT_KINDS, requestSchema, SNAPSHOT_KINDS, type RequestValues } from '../schemas';
import type { ReportKind } from '../types';

export type Intent = 'show' | 'export';

/** The days a report covers, unless it is a snapshot of now. */
function Days() {
  const { t } = useTranslation('reports');
  const kind = useFieldValue('kind') as ReportKind;
  if (SNAPSHOT_KINDS.includes(kind)) {
    return <p className="text-sm text-muted-foreground">{t('form.snapshot')}</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <TextField<RequestValues> name="from" type="date" label={t('form.from')} required />
      <TextField<RequestValues> name="to" type="date" label={t('form.to')} required />
    </div>
  );
}

/**
 * Which report and which days. Two ways to ask: "Show report" works it out now (up to 31 days),
 * and "Export" has a job make it and keep it with a CSV file (up to a year), for
 * `report:export`. Which button was pressed is told to `onSubmit` through `intentRef`.
 */
export function ReportForm({
  initial,
  intentRef,
  pending,
  onSubmit,
}: {
  initial: RequestValues;
  intentRef: MutableRefObject<Intent>;
  pending: boolean;
  onSubmit: (values: RequestValues, intent: Intent) => Promise<void>;
}) {
  const { t } = useTranslation('reports');
  const form = useZodForm(requestSchema, initial);
  return (
    <Form
      form={form}
      onSubmit={(values) => onSubmit(values, intentRef.current)}
      className="max-w-xl"
    >
      <SelectField<RequestValues>
        name="kind"
        label={t('form.kind')}
        required
        options={REPORT_KINDS.map((value) => ({ value, label: t(`kinds.${value}`) }))}
      />
      <Days />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={pending} onClick={() => (intentRef.current = 'show')}>
          {t('form.show')}
        </SubmitButton>
        <Can permission="report:export">
          <SubmitButton
            pending={pending}
            variant="outline"
            onClick={() => (intentRef.current = 'export')}
          >
            {t('form.export')}
          </SubmitButton>
        </Can>
      </div>
    </Form>
  );
}
