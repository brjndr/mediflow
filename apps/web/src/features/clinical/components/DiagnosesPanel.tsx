import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { CodeSearch, type Code } from '@/features/codes';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useDiagnoses, useRecordDiagnosis, useRetractDiagnosis } from '../hooks/use-clinical';
import {
  blankDiagnosis,
  diagnosisName,
  DIAGNOSIS_KINDS,
  DIAGNOSIS_TEXT_MAX,
  diagnosisFormSchema,
  REASON_MAX,
  reasonSchema,
  toDiagnosisCreate,
  type DiagnosisValues,
  type ReasonValues,
} from '../schemas';
import type { Diagnosis, Encounter } from '../types';

const REFUSED: Record<string, string> = {
  encounter_not_open: 'diagnoses.refused.notOpen',
  unknown_code: 'diagnoses.refused.unknownCode',
  already_retracted: 'diagnoses.refused.alreadyRetracted',
  diagnosis_not_found: 'diagnoses.refused.gone',
};

function useRefusal(error: unknown) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  const key = code === undefined ? undefined : REFUSED[code];
  return key ? t(key) : tCommon(errorMessageKey(error));
}

/**
 * The encounter's diagnoses, for `diagnosis:read`, oldest first with the retracted ones kept and
 * marked. `diagnosis:write` records one while the encounter is open (an ICD-10 code from the
 * search, words, or both) and retracts one with a reason, also after it closed.
 */
export function DiagnosesPanel({ encounter }: { encounter: Encounter }) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const canWrite = usePermission('diagnosis:write');
  const diagnoses = useDiagnoses(encounter.id);
  const box = useRef<HTMLElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const [retracting, setRetracting] = useState<Diagnosis | null>(null);
  usePanelFocus(retracting?.id ?? null, box, status);
  const rows = useMemo(
    () => diagnoses.data?.pages.flatMap((page) => page.items) ?? [],
    [diagnoses.data],
  );
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<Diagnosis>[]>(
    () => [
      {
        id: 'diagnosis',
        header: t('diagnoses.columns.diagnosis'),
        value: (row) => diagnosisName(row),
        hideable: false,
        render: (row, text) =>
          row.retractedAt ? (
            <span className="text-muted-foreground line-through">{text}</span>
          ) : (
            text
          ),
      },
      {
        id: 'kind',
        header: t('diagnoses.columns.kind'),
        value: (row) => t(`diagnoses.kind.${row.kind}`),
      },
      {
        id: 'recorded',
        header: t('diagnoses.columns.recorded'),
        value: (row) =>
          t('diagnoses.recordedBy', {
            name: row.recordedByName,
            time: format.dateTime(row.recordedAt),
          }),
      },
      {
        id: 'status',
        header: t('diagnoses.columns.status'),
        // A word, never the strike-through alone.
        value: (row) =>
          row.retractedAt
            ? t('diagnoses.retracted', {
                name: row.retractedByName ?? '',
                time: format.dateTime(row.retractedAt),
                reason: row.retractionReason ?? '',
              })
            : t('diagnoses.stands'),
      },
    ],
    [t, format],
  );

  const actions = useMemo<GridAction<Diagnosis>[]>(
    () =>
      encounter.status === 'cancelled'
        ? []
        : [
            {
              id: 'retract',
              label: t('diagnoses.retract'),
              requires: 'diagnosis:write',
              disabled: (row) => row.retractedAt !== undefined,
              onSelect: (row) => setRetracting(row),
            },
          ],
    [t, encounter.status],
  );

  return (
    <section ref={box} aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('diagnoses.heading')}
      </h2>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {message.text}
      </p>
      <DataGrid
        label={t('diagnoses.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => diagnosisName(row)}
        actions={actions}
        status={diagnoses.isPending ? 'loading' : diagnoses.isError ? 'error' : 'ready'}
        errorMessage={diagnoses.isError ? tCommon(errorMessageKey(diagnoses.error)) : undefined}
        onRetry={() => void diagnoses.refetch()}
        emptyMessage={t('diagnoses.empty')}
        hasNextPage={diagnoses.hasNextPage}
        loadingMore={diagnoses.isFetchingNextPage}
        onLoadMore={() => void diagnoses.fetchNextPage()}
      />
      {retracting && (
        <RetractForm
          diagnosis={retracting}
          onCancel={() => setRetracting(null)}
          onRetracted={() => {
            setRetracting(null);
            say(t('diagnoses.retractedNow'));
          }}
        />
      )}
      {canWrite && encounter.status === 'open' && !retracting && (
        <AddDiagnosis encounterId={encounter.id} onRecorded={() => say(t('diagnoses.recorded'))} />
      )}
    </section>
  );
}

function RetractForm({
  diagnosis,
  onCancel,
  onRetracted,
}: {
  diagnosis: Diagnosis;
  onCancel: () => void;
  onRetracted: () => void;
}) {
  const { t } = useTranslation('clinical');
  const retract = useRetractDiagnosis(diagnosis.encounterId);
  const form = useZodForm(reasonSchema, { reason: '' });
  const failure = useRefusal(retract.error);
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('diagnoses.retractHeading', { name: diagnosisName(diagnosis) })}
      </h3>
      <Form
        form={form}
        onSubmit={(values: ReasonValues) =>
          retract.mutate(
            { diagnosisId: diagnosis.id, reason: values.reason },
            { onSuccess: onRetracted },
          )
        }
      >
        <TextField<ReasonValues>
          name="reason"
          label={t('diagnoses.retractReason')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={retract.isPending}>{t('diagnoses.retractSubmit')}</SubmitButton>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </Form>
    </div>
  );
}

/** Records a diagnosis: a code chosen from the search, words, or both, and whether it is final. */
function AddDiagnosis({
  encounterId,
  onRecorded,
}: {
  encounterId: string;
  onRecorded: () => void;
}) {
  const { t } = useTranslation('clinical');
  const headingId = useId();
  const record = useRecordDiagnosis(encounterId);
  const form = useZodForm(diagnosisFormSchema, blankDiagnosis);
  const [code, setCode] = useState<Code | null>(null);
  const failure = useRefusal(record.error);
  const codeBox = useRef<HTMLDivElement>(null);

  const choose = (chosen: Code | null) => {
    setCode(chosen);
    form.setValue('codeId', chosen?.id ?? '', { shouldValidate: form.formState.isSubmitted });
    // The search and the chosen code take each other's place: focus goes to what replaced it.
    requestAnimationFrame(() =>
      focusIfLost(codeBox.current?.querySelector<HTMLElement>('button, input')),
    );
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h3 id={headingId} className="font-semibold">
        {t('diagnoses.form.heading')}
      </h3>
      <Form
        form={form}
        onSubmit={(values) =>
          record.mutate(toDiagnosisCreate(values), {
            onSuccess: () => {
              form.reset(blankDiagnosis);
              setCode(null);
              onRecorded();
            },
          })
        }
      >
        <div ref={codeBox}>
          {code ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{t('diagnoses.form.chosen', { code: code.code, title: code.title })}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => choose(null)}>
                {t('diagnoses.form.removeCode')}
              </Button>
            </div>
          ) : (
            <CodeSearch system="icd10" label={t('diagnoses.form.code')} onSelect={choose} />
          )}
        </div>
        <TextField<DiagnosisValues>
          name="text"
          label={t('diagnoses.form.text')}
          hint={t('diagnoses.form.textHint')}
          maxLength={DIAGNOSIS_TEXT_MAX}
          autoComplete="off"
        />
        <SelectField<DiagnosisValues>
          name="kind"
          label={t('diagnoses.form.kind')}
          required
          options={DIAGNOSIS_KINDS.map((kind) => ({
            value: kind,
            label: t(`diagnoses.kind.${kind}`),
          }))}
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <SubmitButton pending={record.isPending} className="self-start">
          {record.isPending ? t('diagnoses.form.saving') : t('diagnoses.form.submit')}
        </SubmitButton>
      </Form>
    </section>
  );
}
