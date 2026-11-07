import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, useZodForm } from '@/shared/ui/form';
import { BLOCK_REASONS, blockSchema, type BlockReason, type BlockValues } from '../schemas';
import type { BoardBed } from '../types';

/**
 * Takes an available bed out of use, with a reason from a list (a list, so that nothing about a
 * patient is written as the reason). Part of the page, opened from the bed's row: its heading
 * takes focus, and it closes with its own button.
 */
export function BlockPanel({
  bed,
  pending,
  onSubmit,
  onBack,
}: {
  bed: BoardBed;
  pending: boolean;
  onSubmit: (reason: BlockReason) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('admissions');
  const form = useZodForm(blockSchema, { reason: '' });
  return (
    <section
      aria-labelledby="bed-block-heading"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2
        id="bed-block-heading"
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('blockPanel.heading', { number: bed.number })}
      </h2>
      <Form
        form={form}
        onSubmit={(values: BlockValues) => {
          if (values.reason !== '') onSubmit(values.reason);
        }}
      >
        <SelectField<BlockValues>
          name="reason"
          label={t('blockPanel.reason')}
          required
          placeholder={t('blockPanel.chooseReason')}
          options={BLOCK_REASONS.map((value) => ({ value, label: t(`reasons.${value}`) }))}
        />
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={pending}>{t('blockPanel.submit')}</SubmitButton>
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
            onClick={onBack}
          >
            {t('blockPanel.back')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
