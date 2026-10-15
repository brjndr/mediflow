import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isApiError } from '@/shared/api';
import { useFeatureFlag, usePermission } from '@/access';
import { Button } from '@/shared/ui/button';
import {
  SelectField,
  TextField,
  useFieldError,
  useFieldValue,
  useSetFieldValue,
} from '@/shared/ui/form';
import {
  PICKER_SIZE,
  SEARCH_DEBOUNCE_MS,
  useComponentChoices,
  useDebouncedValue,
  useServiceChoices,
} from '../hooks/use-lab-tests';
import {
  CODE_MAX,
  COMPONENTS_MAX,
  CONTAINER_MAX,
  DEPARTMENTS,
  joinIds,
  KINDS,
  NAME_MAX,
  RESULT_TYPES,
  SAMPLE_TYPES,
  splitIds,
  UNIT_MAX,
} from '../schemas';
import type { LabTestComponent } from '../types';

const control =
  'h-9 w-full rounded-md border bg-background px-3 text-base outline-none md:text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11';

/** A service the form can name without asking: the one a test is already linked to. */
export interface KnownService {
  id: string;
  name: string;
  code?: string;
}

const serviceLabel = (service: KnownService) =>
  service.code ? `${service.name} (${service.code})` : service.name;

/**
 * The service a test is charged as, picked from the laboratory services of the price catalog.
 * The catalog can be long, so a few are offered and the rest are found by typing.
 */
function ServiceField({ known }: { known: KnownService[] }) {
  const { t } = useTranslation('lab_tests');
  const { t: tCommon } = useTranslation();
  const searchId = useId();
  // The price catalog is another module: it has to be switched on, and open to this person.
  const allowed = usePermission('service:read');
  const switchedOn = useFeatureFlag('services');
  const maySee = allowed && switchedOn;
  const [search, setSearch] = useState('');
  const choices = useServiceChoices(useDebouncedValue(search, SEARCH_DEBOUNCE_MS), maySee);
  const selected = String(useFieldValue('serviceId') ?? '');
  // The service chosen stays an option when the search moves on to others.
  const [remembered, setRemembered] = useState<KnownService>();

  const items = choices.data?.items ?? [];
  const hit = items.find((item) => item.id === selected);
  if (hit && hit.id !== remembered?.id) setRemembered(hit);
  // Every service the form can name is an option, so the one that is chosen never falls out of
  // the list: not while the search moves on, and not when someone else's link arrives.
  const extras = [...(remembered ? [remembered] : []), ...known].filter(
    (item, index, all) =>
      !items.some((other) => other.id === item.id) &&
      all.findIndex((other) => other.id === item.id) === index,
  );
  const current = hit ?? extras.find((item) => item.id === selected);
  const refused = isApiError(choices.error) && choices.error.code === 'forbidden';

  // Without the price catalog there is nothing to pick from: the link stays as it is.
  if (!maySee || refused) {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('form.serviceId')}</span>
        <span>{current ? serviceLabel(current) : t('form.noService')}</span>
        <span className="text-xs text-muted-foreground">{t('form.serviceUnavailable')}</span>
      </div>
    );
  }

  const options = [...extras, ...items];
  return (
    <div className="flex flex-col gap-2">
      {/* A search that failed leaves the picker, with what it had, and a way to ask again. */}
      {choices.isError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t('form.serviceFailed')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void choices.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={searchId} className="text-sm font-medium">
          {t('form.serviceSearch')}
        </label>
        <input
          id={searchId}
          type="search"
          value={search}
          maxLength={100}
          autoComplete="off"
          placeholder={t('form.serviceSearchPlaceholder')}
          onChange={(event) => setSearch(event.target.value)}
          className={control}
        />
      </div>
      <SelectField
        name="serviceId"
        label={t('form.serviceId')}
        hint={
          choices.data?.more
            ? `${t('form.serviceHint')} ${t('form.serviceMore', { count: PICKER_SIZE })}`
            : t('form.serviceHint')
        }
        placeholder={t('form.noService')}
        options={options.map((item) => ({ value: item.id, label: serviceLabel(item) }))}
      />
    </div>
  );
}

/**
 * The tests of a panel, in the order they are reported. The form holds their ids as one field;
 * the names come from the tests the panel already has and from what is picked here.
 */
function ComponentsField({ known }: { known: LabTestComponent[] }) {
  const { t } = useTranslation('lab_tests');
  const searchId = useId();
  const choiceId = useId();
  const errorId = useId();
  const ids = splitIds(String(useFieldValue('componentIds') ?? ''));
  const setValue = useSetFieldValue();
  const message = useFieldError('componentIds');
  const [search, setSearch] = useState('');
  const choices = useComponentChoices(useDebouncedValue(search, SEARCH_DEBOUNCE_MS), true);
  const [picked, setPicked] = useState<LabTestComponent[]>([]);
  const [choice, setChoice] = useState('');

  const named = new Map([...known, ...picked].map((component) => [component.id, component]));
  const available = (choices.data?.items ?? []).filter((test) => !ids.includes(test.id));
  const chosen = available.find((test) => test.id === choice);
  const set = (next: string[]) => setValue('componentIds', joinIds(next));

  const add = () => {
    if (!chosen) return;
    setPicked([...picked, { id: chosen.id, code: chosen.code, name: chosen.name }]);
    set([...ids, chosen.id]);
    setChoice('');
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...ids];
    const [id] = next.splice(index, 1);
    if (id === undefined) return;
    next.splice(index + by, 0, id);
    set(next);
  };

  return (
    <fieldset
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-describedby={message ? errorId : undefined}
    >
      <legend className="px-1 text-sm font-medium">
        {t('form.componentIds')}
        <span aria-hidden className="text-destructive">
          {' *'}
        </span>
      </legend>
      <p className="text-xs text-muted-foreground">{t('form.componentsHint')}</p>
      {ids.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('form.componentsNone')}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {ids.map((id, index) => {
            const name = named.get(id)?.name ?? id;
            return (
              <li key={id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-words">
                  {name}
                  <span className="text-muted-foreground"> · {named.get(id)?.code ?? ''}</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled={index === 0 || undefined}
                  aria-label={t('form.moveUp', { name })}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled={index === ids.length - 1 || undefined}
                  aria-label={t('form.moveDown', { name })}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('form.removeComponent', { name })}
                  onClick={() => set(ids.filter((other) => other !== id))}
                >
                  ×
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {message && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <label htmlFor={searchId} className="text-sm font-medium">
            {t('form.componentSearch')}
          </label>
          <input
            id={searchId}
            type="search"
            value={search}
            maxLength={100}
            autoComplete="off"
            placeholder={t('filters.searchPlaceholder')}
            onChange={(event) => setSearch(event.target.value)}
            className={control}
          />
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <label htmlFor={choiceId} className="text-sm font-medium">
            {t('form.componentChoice')}
          </label>
          <select
            id={choiceId}
            value={chosen ? choice : ''}
            onChange={(event) => setChoice(event.target.value)}
            className={control}
          >
            <option value="">
              {available.length === 0 && choices.isSuccess
                ? t('form.componentsNoMatch')
                : t('form.chooseComponent')}
            </option>
            {available.map((test) => (
              <option key={test.id} value={test.id}>
                {test.name} ({test.code})
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          variant="outline"
          aria-disabled={!chosen || ids.length >= COMPONENTS_MAX || undefined}
          onClick={add}
        >
          {t('form.addComponent')}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * The fields of a test, whether it is being added or changed. Inside a form of the kit. The code
 * and the kind are asked only when adding: neither changes afterwards.
 */
export function LabTestFields({
  adding = false,
  components = [],
  services = [],
}: {
  adding?: boolean;
  /** Tests the panel is known to have, for their names. */
  components?: LabTestComponent[];
  /** Services the test is known to be linked to, for their names. */
  services?: KnownService[];
}) {
  const { t } = useTranslation('lab_tests');
  const panel = useFieldValue('kind') === 'panel';
  const numeric = useFieldValue('resultType') === 'numeric';
  return (
    <>
      {adding && (
        <TextField
          name="code"
          label={t('form.code')}
          hint={t('form.codeHint')}
          required
          maxLength={CODE_MAX}
          autoComplete="off"
        />
      )}
      <TextField
        name="name"
        label={t('form.name')}
        required
        maxLength={NAME_MAX}
        autoComplete="off"
      />
      {adding && (
        <SelectField
          name="kind"
          label={t('form.kind')}
          hint={t('form.kindHint')}
          required
          options={KINDS.map((value) => ({ value, label: t(`kinds.${value}`) }))}
        />
      )}
      <SelectField
        name="department"
        label={t('form.department')}
        required
        placeholder={t('form.chooseDepartment')}
        options={DEPARTMENTS.map((value) => ({ value, label: t(`departments.${value}`) }))}
      />
      {!panel && (
        <SelectField
          name="resultType"
          label={t('form.resultType')}
          hint={t('form.resultTypeHint')}
          required
          placeholder={t('form.chooseResultType')}
          options={RESULT_TYPES.map((value) => ({ value, label: t(`resultTypes.${value}`) }))}
        />
      )}
      {!panel && numeric && (
        <TextField
          name="unit"
          label={t('form.unit')}
          hint={t('form.unitHint')}
          maxLength={UNIT_MAX}
          autoComplete="off"
        />
      )}
      <SelectField
        name="sampleType"
        label={t('form.sampleType')}
        required
        placeholder={t('form.chooseSampleType')}
        options={SAMPLE_TYPES.map((value) => ({ value, label: t(`sampleTypes.${value}`) }))}
      />
      <TextField
        name="container"
        label={t('form.container')}
        hint={t('form.containerHint')}
        maxLength={CONTAINER_MAX}
        autoComplete="off"
      />
      <TextField
        name="turnaroundHours"
        label={t('form.turnaroundHours')}
        hint={t('form.turnaroundHoursHint')}
        required
        inputMode="numeric"
        maxLength={3}
        autoComplete="off"
      />
      <ServiceField known={services} />
      {panel && <ComponentsField known={components} />}
    </>
  );
}
