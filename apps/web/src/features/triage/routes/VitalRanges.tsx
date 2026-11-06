import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { Button } from '@/shared/ui/button';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { useSaveVitalRanges, useVitalRangeTable } from '../hooks/use-triage';
import {
  BANDS,
  RANGED,
  rangesFormSchema,
  toRangesValues,
  toRangeTable,
  type RangesValues,
} from '../schemas';
import type { VitalRangeTable } from '../types';

/** The ranges as a table of age bands, one fieldset each, with a low and a high for every measure. */
function Editor({ table }: { table: VitalRangeTable }) {
  const { t } = useTranslation('triage');
  const { t: tCommon } = useTranslation();
  const save = useSaveVitalRanges();
  const form = useZodForm(rangesFormSchema, toRangesValues(table));
  // The version a save is made from. After a conflict it moves to the newest one while the form
  // keeps what was typed: saving again replaces the other person's ranges with these.
  const [expected, setExpected] = useState(table.version);
  const [conflict, setConflict] = useState<'none' | 'awaiting' | 'shown'>('none');
  const [done, setDone] = useState<string | null>(null);

  if (conflict === 'awaiting' && table.version !== expected) {
    setExpected(table.version);
    setConflict('shown');
  }

  const onSubmit = async (values: RangesValues) => {
    setDone(null);
    try {
      const saved = await save.mutateAsync(toRangeTable(values, expected));
      form.reset(toRangesValues(saved));
      setExpected(saved.version);
      setConflict('none');
      setDone(t('ranges.saved'));
    } catch (error) {
      if (isConflict(error)) setConflict('awaiting');
    }
  };

  return (
    <Form form={form} onSubmit={onSubmit} className="gap-6">
      {BANDS.map((band) => (
        <fieldset key={band} className="flex flex-col gap-4 rounded-md border p-4">
          <legend className="px-1 text-base font-semibold">{t(`ranges.bands.${band}`)}</legend>
          {RANGED.map((measure) => (
            <fieldset key={measure} className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t(`ranges.measures.${measure}`)}</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField<RangesValues>
                  name={`bands.${band}.${measure}.low`}
                  label={t('ranges.low')}
                  inputMode="decimal"
                  autoComplete="off"
                />
                <TextField<RangesValues>
                  name={`bands.${band}.${measure}.high`}
                  label={t('ranges.high')}
                  inputMode="decimal"
                  autoComplete="off"
                />
              </div>
            </fieldset>
          ))}
        </fieldset>
      ))}

      {save.isError && !isConflict(save.error) && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(save.error))}
        </p>
      )}
      {conflict !== 'none' && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {conflict === 'shown' ? t('ranges.conflict') : t('ranges.conflictReading')}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>
      <div className="flex flex-wrap gap-3">
        <SubmitButton pending={save.isPending}>{t('ranges.save')}</SubmitButton>
        <Button
          type="button"
          variant="outline"
          aria-disabled={save.isPending || undefined}
          onClick={() => {
            if (save.isPending) return;
            form.reset(toRangesValues(table));
            setDone(null);
            setConflict('none');
            save.reset();
          }}
        >
          {t('ranges.reset')}
        </Button>
      </div>
    </Form>
  );
}

const isConflict = (error: unknown) => isApiError(error) && error.serverCode === 'conflict';

function Ranges() {
  const { t } = useTranslation('triage');
  const table = useVitalRangeTable();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('ranges.heading')}</h1>
        <p className="text-muted-foreground">{t('ranges.description')}</p>
      </div>
      {table.isPending && <PageSkeleton label={t('ranges.loading')} rows={3} />}
      {table.isError && (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-sm text-destructive">{t('ranges.failed')}</p>
          <Button variant="outline" onClick={() => void table.refetch()}>
            {t('ranges.retry')}
          </Button>
        </div>
      )}
      {table.data && <Editor table={table.data} />}
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function VitalRanges() {
  return (
    <DesktopOnly>
      <Ranges />
    </DesktopOnly>
  );
}
