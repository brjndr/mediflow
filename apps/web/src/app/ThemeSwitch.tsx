import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applySchemeChoice,
  readSchemeChoice,
  SCHEME_CHOICES,
  storeSchemeChoice,
  watchSystemScheme,
  type SchemeChoice,
} from '@/shared/lib/color-scheme';
import { Button } from '@/shared/ui/button';

const icons = { light: Sun, dark: Moon, system: Monitor } as const;

/**
 * Light, dark or system, cycled by one button in the header. Its name says the current choice and
 * what a press does, so the state is not carried by the icon alone. The name changes with the choice, so it is read on the button
 * itself; no live region, which would keep the header out of reach of a dialog's aria-hidden (#730).
 */
export function ThemeSwitch() {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<SchemeChoice>(readSchemeChoice);

  useEffect(() => {
    applySchemeChoice(choice);
    return watchSystemScheme(() => choice);
  }, [choice]);

  const next = SCHEME_CHOICES[(SCHEME_CHOICES.indexOf(choice) + 1) % SCHEME_CHOICES.length]!;
  const Icon = icons[choice];

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t('theme.button', {
        current: t(`theme.${choice}`),
        next: t(`theme.${next}`),
      })}
      onClick={() => {
        storeSchemeChoice(next);
        setChoice(next);
      }}
    >
      <Icon aria-hidden className="size-4" />
    </Button>
  );
}
