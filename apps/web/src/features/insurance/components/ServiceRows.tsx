import { useTranslation } from 'react-i18next';
import { ServiceSearch } from '@/features/services';
import { Button } from '@/shared/ui/button';
import { TextField, useFieldError, useFieldRows, useFieldValue } from '@/shared/ui/form';

/**
 * A list of services built by picking them from the catalog (searched on the server), each with an
 * amount: a limit for a covered service, a rate for an agreed one. Inside a form of the kit, as
 * the rows of `name`. A service already in the list is not added twice.
 */
export function ServiceRows({
  name,
  label,
  amountLabel,
  amountHint,
  required,
  emptyText,
}: {
  name: string;
  /** Names the search box: what the services are for. */
  label: string;
  amountLabel: string;
  amountHint?: string;
  required?: boolean;
  emptyText: string;
}) {
  const { t } = useTranslation('insurance');
  const rows = useFieldRows(name);
  const current = (useFieldValue(name) as { serviceId: string; name: string }[] | undefined) ?? [];
  const problem = useFieldError(name);
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <ServiceSearch
        label={t('services.add')}
        onSelect={(service) => {
          if (current.some((row) => row.serviceId === service.id)) return;
          rows.add({ serviceId: service.id, name: service.name, amount: '' });
        }}
      />
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {rows.keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.keys.map((key, index) => (
            <li key={key} className="flex flex-wrap items-start gap-3 rounded-md border p-3">
              <span className="min-w-40 flex-1 pt-2 text-sm font-medium">
                {current[index]?.name}
              </span>
              <div className="w-44">
                <TextField
                  name={`${name}.${index}.amount`}
                  label={amountLabel}
                  hint={amountHint}
                  required={required}
                  inputMode="decimal"
                  autoComplete="off"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                className="self-end"
                onClick={() => rows.remove(index)}
              >
                {t('services.remove')}
                <span className="sr-only">{current[index]?.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
