import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { Button } from '@/shared/ui/button';
import { StatusBadge } from '@/shared/ui/status-badge';
import { useFormatters } from '@/tenancy';
import { useSaveAdvice, useSetClearance } from '../hooks/use-discharge-plan';
import { dischargeAdviceSchema, DISCHARGE_ADVICE_MAX } from '../schemas';
import { REQUIRED_CLEARANCES, type DischargePlan, type DischargeType } from '../types';

/**
 * The discharge plan (DS-01, #164): the advice for the patient and the clearances of the wards,
 * the pharmacy (medicines to return) and the laboratory (work still pending). Which of them the
 * discharge waits for follows the way the stay ends. The server decides; this lists what is open.
 */
export function DischargePlanSection({
  admissionId,
  plan,
  type,
}: {
  admissionId: string;
  plan: DischargePlan;
  type: DischargeType;
}) {
  const { t } = useTranslation('admissions');
  const format = useFormatters();
  const { t: tCommon } = useTranslation('common');
  const save = useSaveAdvice(admissionId);
  const clear = useSetClearance(admissionId);
  const [advice, setAdvice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const text = advice ?? plan.advice ?? '';
  const required = REQUIRED_CLEARANCES[type];

  const saveAdvice = async () => {
    if (save.isPending) return;
    const parsed = dischargeAdviceSchema.safeParse({ advice: text });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      setSaved(false);
      return;
    }
    setError(undefined);
    try {
      await save.mutateAsync({ advice: parsed.data.advice, version: plan.version });
      setAdvice(undefined);
      setSaved(true);
    } catch {
      setSaved(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="discharge-plan">
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('plan.advice.label')}
          <textarea
            value={text}
            rows={4}
            maxLength={DISCHARGE_ADVICE_MAX}
            readOnly={save.isPending}
            aria-invalid={error !== undefined || undefined}
            aria-describedby="discharge-advice-status"
            onChange={(event) => {
              setAdvice(event.target.value);
              setSaved(false);
            }}
            className="rounded-md border bg-background p-2 text-base font-normal md:text-sm"
          />
        </label>
        <p id="discharge-advice-status" role="status" className="text-sm text-muted-foreground">
          {error !== undefined && <span className="text-destructive">{tCommon(error)}</span>}
          {error === undefined && save.isError && t('plan.advice.failed')}
          {error === undefined && !save.isError && saved && t('plan.advice.saved')}
        </p>
        <Can permission="admission:discharge">
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            aria-disabled={save.isPending || advice === undefined || undefined}
            onClick={() => void saveAdvice()}
          >
            {t('plan.advice.save')}
          </Button>
        </Can>
      </div>

      <section aria-labelledby="discharge-clearances-heading" className="flex flex-col gap-2">
        <h3 id="discharge-clearances-heading" className="text-sm font-semibold">
          {t('plan.clearances.heading')}
        </h3>
        <ul className="flex flex-col gap-2">
          {plan.clearances.map((item) => {
            const needed = required.includes(item.kind);
            const done = item.status === 'cleared';
            return (
              <li
                key={item.kind}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{t(`plan.clearances.kinds.${item.kind}`)}</span>
                  <span className="text-muted-foreground">
                    {done && item.clearedAt
                      ? t('plan.clearances.by', {
                          name: item.clearedByName ?? '',
                          at: format.dateTime(item.clearedAt),
                        })
                      : needed
                        ? t('plan.clearances.required')
                        : t('plan.clearances.optional')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge
                    tone={done ? 'success' : needed ? 'warning' : 'neutral'}
                    label={t(done ? 'plan.clearances.cleared' : 'plan.clearances.pending')}
                  />
                  <Can permission="discharge:clear">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-disabled={clear.isPending || undefined}
                      aria-label={t(
                        done ? 'plan.clearances.reopenFor' : 'plan.clearances.clearFor',
                        {
                          kind: t(`plan.clearances.kinds.${item.kind}`),
                        },
                      )}
                      onClick={() => {
                        if (!clear.isPending) {
                          clear.mutate({
                            kind: item.kind,
                            status: done ? 'pending' : 'cleared',
                            version: plan.version,
                          });
                        }
                      }}
                    >
                      {t(done ? 'plan.clearances.reopen' : 'plan.clearances.clear')}
                    </Button>
                  </Can>
                </div>
              </li>
            );
          })}
        </ul>
        <p role="status" className="text-sm text-destructive">
          {clear.isError && t('plan.clearances.failed')}
        </p>
      </section>
    </div>
  );
}
