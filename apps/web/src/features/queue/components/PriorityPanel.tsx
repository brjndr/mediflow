import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, useZodForm } from '@/shared/ui/form';
import { PRIORITIES } from '../schemas';
import type { QueuePriority, QueueToken } from '../types';

const prioritySchema = z.object({ priority: z.enum(PRIORITIES).or(z.literal('')) });
type PriorityValues = z.infer<typeof prioritySchema>;

/**
 * Sets or clears why a waiting or skipped token goes ahead. Part of the page, opened from the
 * token's row: its heading takes focus, and it closes with its own button.
 */
export function PriorityPanel({
  token,
  pending,
  onSave,
  onCancel,
}: {
  token: QueueToken;
  pending: boolean;
  onSave: (priority: QueuePriority | null) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('queue');
  const form = useZodForm(prioritySchema, { priority: token.priority ?? '' });
  return (
    <section
      aria-labelledby="queue-priority-heading"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2
        id="queue-priority-heading"
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('priorityPanel.heading', { number: token.number, patient: token.patientName })}
      </h2>
      <Form form={form} onSubmit={(values: PriorityValues) => onSave(values.priority || null)}>
        <SelectField<PriorityValues>
          name="priority"
          label={t('priorityPanel.label')}
          placeholder={t('priority.none')}
          options={PRIORITIES.map((value) => ({ value, label: t(`priority.${value}`) }))}
        />
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={pending}>{t('priorityPanel.save')}</SubmitButton>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('priorityPanel.cancel')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
