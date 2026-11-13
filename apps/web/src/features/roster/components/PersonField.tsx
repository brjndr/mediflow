import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StaffSearch } from '@/features/staff';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { useFieldError, useFieldValue, useSetFieldValue } from '@/shared/ui/form';

/**
 * The person on a shift, found by a search on the server (a hospital may have far more staff
 * than a list can hold). The chosen name stays shown, with a way to search again; the form holds
 * only the id, in a field named `userId`.
 */
export function PersonField({ label }: { label?: string }) {
  const { t } = useTranslation('roster');
  const setValue = useSetFieldValue();
  const userId = useFieldValue('userId') as string;
  const error = useFieldError('userId');
  const [name, setName] = useState('');
  const empty = userId === '';
  const errorId = 'roster-person-error';
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const text = label ?? t('new.person');
  // The box or the name goes away when the other shows: keep the keyboard where it was.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    focusIfLost(box.current?.querySelector<HTMLElement>('input, button'));
  }, [empty]);
  return (
    <div ref={box} className="space-y-2">
      {!empty ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">{text}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('new.chosen', { name })}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setValue('userId', '');
                setName('');
              }}
            >
              {t('new.change')}
            </Button>
          </p>
        </div>
      ) : (
        <StaffSearch
          label={text}
          invalid={error !== undefined}
          describedBy={error ? errorId : undefined}
          onSelect={(person) => {
            setName(person.name);
            setValue('userId', person.id);
          }}
        />
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
