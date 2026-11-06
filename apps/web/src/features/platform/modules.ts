import { useTranslation } from 'react-i18next';

/** The regions a hospital's data can live in. One for now; add a code here for another. */
export const REGIONS = ['in'] as const;

/** The authenticator's two switches, kept with the module flags (`mfa_required` needs `mfa`). */
export const MFA_SWITCH = 'mfa';
export const MFA_REQUIRED_SWITCH = 'mfa_required';

/** A module's display name; an id the web app has no name for is shown as it is. */
export function useModuleName() {
  const { t, i18n } = useTranslation();
  return (id: string) => (i18n.exists(`platform.modules.${id}`) ? t(`platform.modules.${id}`) : id);
}
