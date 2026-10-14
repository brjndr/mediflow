import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isKnownKind } from '../schemas';

export const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** The name of a kind of record, or its code for a kind this app has no words for. */
export function useKindName() {
  const { t } = useTranslation('imports');
  return useCallback((kind: string) => (isKnownKind(kind) ? t(`kinds.${kind}`) : kind), [t]);
}

/** The name of a field of a kind, or the field's own name for one this app has no words for. */
export function useFieldName() {
  const { t, i18n } = useTranslation('imports');
  return useCallback(
    (kind: string, field: string) => {
      const key = `fields.${kind}.${field}`;
      return i18n.exists(key, { ns: 'imports' }) ? t(key) : field;
    },
    [t, i18n],
  );
}
