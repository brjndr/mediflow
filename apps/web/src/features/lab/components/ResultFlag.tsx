import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LabResultFlag } from '../types';

/**
 * A result's flag, as the API read it against the patient's range (#91): a word and an icon, so
 * colour is never the only sign. The browser never works a flag out itself, so the page cannot
 * disagree with the API (#310). No flag (a text result, or no range): nothing.
 */
export function ResultFlag({ flag }: { flag: LabResultFlag | undefined }) {
  const { t } = useTranslation('lab');
  if (!flag) return null;
  const critical = flag === 'critical_low' || flag === 'critical_high';
  const Icon = critical
    ? TriangleAlert
    : flag === 'low'
      ? ArrowDown
      : flag === 'high'
        ? ArrowUp
        : null;
  return (
    <span
      className={
        critical
          ? 'inline-flex items-center gap-1 font-semibold text-destructive'
          : flag === 'normal'
            ? 'inline-flex items-center gap-1 text-muted-foreground'
            : 'inline-flex items-center gap-1 font-semibold'
      }
    >
      {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
      {t(`flag.${flag}`)}
    </span>
  );
}
