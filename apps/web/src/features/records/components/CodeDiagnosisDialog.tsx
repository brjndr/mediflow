import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeSearch, type Code } from '@/features/codes';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { useCodeDiagnosis } from '../hooks/use-records';
import type { CodingItem } from '../types';

const REFUSED: Record<string, string> = {
  version_conflict: 'coding.errors.conflict',
};

/**
 * Gives a diagnosis written as text its ICD-10 code (MR-04, #192). The text is shown for the
 * coder to read; the code is searched on the server and chosen, never typed free. Saved at the
 * version the list read, so a diagnosis changed meanwhile is refused and the list read again.
 */
export function CodeDiagnosisDialog({
  item,
  onClose,
  onCoded,
}: {
  item: CodingItem;
  onClose: () => void;
  onCoded: (coded: CodingItem) => void;
}) {
  const { t } = useTranslation('records');
  const { t: tCommon } = useTranslation();
  const coding = useCodeDiagnosis(item.diagnosisId);
  const [chosen, setChosen] = useState<Code | null>(null);

  const save = async () => {
    if (!chosen) return;
    try {
      onCoded(await coding.mutateAsync({ codeId: chosen.id, version: item.version }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  const code = isApiError(coding.error) ? coding.error.serverCode : undefined;
  const failure = coding.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(coding.error))
    : undefined;

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('coding.dialogTitle', { name: item.patientName })}
      description={t('coding.dialogDescription')}
      closeLabel={t('close')}
      busy={coding.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={!chosen} aria-busy={coding.isPending}>
            {coding.isPending ? t('coding.saving') : t('coding.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          <span className="font-medium">{t('coding.written')}</span> {item.text}
        </p>
        {item.code && (
          <p className="text-sm text-muted-foreground">
            {t('coding.current', { code: item.code.code, title: item.code.title })}
          </p>
        )}
        <CodeSearch system="icd10" label={t('coding.search')} onSelect={setChosen} />
        {chosen && (
          <p role="status" className="text-sm">
            {t('coding.chosen', { code: chosen.code, title: chosen.title })}
          </p>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}
