import { useEffect, useMemo, useRef, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { themeFromBrandColor } from '@/shared/lib/theme';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { REGIONS, STARTING_MODULES } from '../modules';
import { hospitalFormSchema, slugFrom, type HospitalFormValues } from '../schemas';

const STEPS = ['identity', 'locale', 'modules'] as const;
type Step = (typeof STEPS)[number];

/** The fields each step asks for, so Next checks the step in view and no other. */
const STEP_FIELDS: Record<Step, (keyof HospitalFormValues)[]> = {
  identity: ['name', 'slug', 'registrationNumber', 'address', 'phone', 'region'],
  locale: ['locale', 'timezone', 'currency', 'themePrimary', 'themeLogoUrl'],
  modules: ['features', 'maxUsers', 'storageMb'],
};

const DEFAULTS: HospitalFormValues = {
  name: '',
  slug: '',
  registrationNumber: '',
  address: '',
  phone: '',
  region: REGIONS[0],
  locale: '',
  timezone: '',
  currency: '',
  themePrimary: '#0f766e',
  themeLogoUrl: '',
  features: [],
  maxUsers: '',
  storageMb: '',
};

interface HospitalWizardProps {
  pending: boolean;
  /** Already translated. Why the last attempt failed, when it is not about one field. */
  error?: string;
  /** Set when the server said the slug is taken: the wizard goes back to it. */
  slugTaken: boolean;
  onSubmit: (values: HospitalFormValues) => void | Promise<void>;
  onCancel: () => void;
}

/** Suggests the slug from the name until the person types one of their own. */
function SlugSuggestion() {
  const { setValue, getFieldState, formState } = useFormContext<HospitalFormValues>();
  const name = String(useFieldValue('name') ?? '');
  const typedByPerson = getFieldState('slug', formState).isDirty;
  useEffect(() => {
    if (!typedByPerson) setValue('slug', slugFrom(name));
  }, [name, typedByPerson, setValue]);
  return null;
}

function IdentityStep() {
  const { t } = useTranslation();
  return (
    <>
      <SlugSuggestion />
      <TextField name="name" label={t('platform.create.name')} required maxLength={200} />
      <TextField
        name="slug"
        label={t('platform.create.slug')}
        hint={t('platform.create.slugHint')}
        required
        maxLength={63}
        autoCapitalize="none"
        spellCheck={false}
      />
      <TextField
        name="registrationNumber"
        label={t('platform.create.registrationNumber')}
        maxLength={100}
      />
      <TextAreaField name="address" label={t('platform.create.address')} maxLength={500} rows={3} />
      <TextField
        name="phone"
        label={t('platform.create.phone')}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        maxLength={32}
      />
      <SelectField
        name="region"
        label={t('platform.create.region')}
        hint={t('platform.create.regionHint')}
        required
        options={REGIONS.map((region) => ({
          value: region,
          label: t(`platform.regions.${region}`),
        }))}
      />
    </>
  );
}

/** How the hospital's brand colour will look, or why it will not be used. */
function BrandPreview() {
  const { t } = useTranslation();
  const name = String(useFieldValue('name') ?? '');
  const colour = String(useFieldValue('themePrimary') ?? '');
  const theme = useMemo(() => themeFromBrandColor(colour), [colour]);
  if (!theme)
    return <p className="text-sm text-muted-foreground">{t('platform.create.previewNone')}</p>;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">{t('platform.create.preview')}</p>
      <div
        className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
        style={{ backgroundColor: theme.primary, color: theme['primary-foreground'] }}
      >
        <span className="font-semibold">{name || t('platform.create.previewName')}</span>
        <span className="rounded-sm border border-current px-2 py-0.5 text-xs">
          {t('platform.create.previewButton')}
        </span>
      </div>
    </div>
  );
}

function LocaleStep() {
  const { t } = useTranslation();
  const currencies = useMemo(
    () =>
      Intl.supportedValuesOf('currency').map((code) => ({
        value: code,
        label: code,
      })),
    [],
  );
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  return (
    <>
      <TextField
        name="locale"
        label={t('platform.create.locale')}
        hint={t('platform.create.localeHint')}
        required
        maxLength={35}
        autoCapitalize="none"
        spellCheck={false}
      />
      <TextField
        name="timezone"
        label={t('platform.create.timezone')}
        hint={t('platform.create.timezoneHint')}
        required
        maxLength={64}
        list="platform-timezones"
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id="platform-timezones">
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <SelectField
        name="currency"
        label={t('platform.create.currency')}
        required
        placeholder={t('platform.create.choose')}
        options={currencies}
      />
      <TextField
        name="themePrimary"
        label={t('platform.create.colour')}
        hint={t('platform.create.colourHint')}
        required
        maxLength={7}
        autoCapitalize="none"
        spellCheck={false}
      />
      <TextField
        name="themeLogoUrl"
        label={t('platform.create.logo')}
        hint={t('platform.create.logoHint')}
        type="url"
        inputMode="url"
        maxLength={2048}
        autoComplete="off"
      />
      <BrandPreview />
    </>
  );
}

function ModulesStep() {
  const { t } = useTranslation();
  const chosen = (useFieldValue('features') as string[] | undefined) ?? [];
  const set = useSetFieldValue();
  const toggle = (module: string, on: boolean) =>
    set('features', on ? [...chosen, module] : chosen.filter((id) => id !== module));
  return (
    <>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t('platform.create.modules')}</legend>
        <p className="mb-1 text-xs text-muted-foreground">{t('platform.create.modulesHint')}</p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {STARTING_MODULES.map((module) => (
            <label
              key={module}
              className="flex min-h-8 items-center gap-2 text-sm pointer-coarse:min-h-11"
            >
              <input
                type="checkbox"
                className="size-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-6"
                checked={chosen.includes(module)}
                onChange={(event) => toggle(module, event.target.checked)}
              />
              {t(`platform.modules.${module}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <TextField
        name="maxUsers"
        label={t('platform.create.maxUsers')}
        hint={t('platform.create.limitHint')}
        inputMode="numeric"
        autoComplete="off"
      />
      <TextField
        name="storageMb"
        label={t('platform.create.storageMb')}
        hint={t('platform.create.limitHint')}
        inputMode="numeric"
        autoComplete="off"
      />
    </>
  );
}

function Review() {
  const { t } = useTranslation();
  const { getValues } = useFormContext<HospitalFormValues>();
  const v = getValues();
  const none = t('platform.create.none');
  const rows: [string, string][] = [
    [t('platform.create.name'), v.name],
    [t('platform.create.slug'), v.slug],
    [t('platform.create.registrationNumber'), v.registrationNumber || none],
    [t('platform.create.address'), v.address || none],
    [t('platform.create.phone'), v.phone || none],
    [t('platform.create.region'), t(`platform.regions.${v.region}`, { defaultValue: v.region })],
    [t('platform.create.locale'), v.locale],
    [t('platform.create.timezone'), v.timezone],
    [t('platform.create.currency'), v.currency],
    [t('platform.create.colour'), v.themePrimary],
    [t('platform.create.logo'), v.themeLogoUrl || none],
    [
      t('platform.create.modules'),
      v.features.length ? v.features.map((id) => t(`platform.modules.${id}`)).join(', ') : none,
    ],
    [t('platform.create.maxUsers'), v.maxUsers || t('platform.create.noLimit')],
    [t('platform.create.storageMb'), v.storageMb || t('platform.create.noLimit')],
  ];
  return (
    <section aria-labelledby="platform-review" className="flex flex-col gap-2">
      <h3 id="platform-review" className="text-base font-semibold">
        {t('platform.create.review')}
      </h3>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Creates a hospital in three steps: who it is, how it looks and speaks, which modules it starts
 * with. One form holds everything, so going back loses nothing; "Next" checks the step in view.
 */
export function HospitalWizard({
  pending,
  error,
  slugTaken,
  onSubmit,
  onCancel,
}: HospitalWizardProps) {
  const { t } = useTranslation();
  const form = useZodForm(hospitalFormSchema, DEFAULTS);
  const [index, setIndex] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const step = STEPS[index] ?? 'identity';
  const last = index === STEPS.length - 1;
  const { setError, setFocus, trigger } = form;

  // A new step starts at its heading, so the keyboard and a screen reader begin there. Not on
  // the first render: the shell has just put the keyboard at the start of the page.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) heading.current?.focus();
    opened.current = true;
  }, [index]);

  // Next checks the fields of the step in view only; Back never blocks. A field that is not
  // valid is named and focused, so the person is never stopped without a reason.
  const next = async () => {
    const fields = STEP_FIELDS[step];
    if (await trigger(fields)) {
      setIndex(index + 1);
      return;
    }
    const firstInvalid = fields.find((name) => form.getFieldState(name).invalid);
    if (firstInvalid) setFocus(firstInvalid);
  };

  // The server says the slug is taken: back to the step that asks for it (adjusted while
  // rendering, so the step is already there when the effect below puts the message on it).
  const [seenTaken, setSeenTaken] = useState(false);
  if (slugTaken !== seenTaken) {
    setSeenTaken(slugTaken);
    if (slugTaken) setIndex(0);
  }
  useEffect(() => {
    if (!slugTaken) return;
    setError('slug', { type: 'server', message: 'platform.create.errors.slugTaken' });
    setFocus('slug');
  }, [slugTaken, setError, setFocus]);

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label={t('platform.create.steps')}>
        {STEPS.map((id, position) => (
          <li
            key={id}
            aria-current={position === index ? 'step' : undefined}
            className={
              position === index
                ? 'rounded-full border border-primary bg-primary px-3 py-1 text-primary-foreground'
                : 'rounded-full border px-3 py-1 text-muted-foreground'
            }
          >
            {position + 1}. {t(`platform.create.step.${id}`)}
          </li>
        ))}
      </ol>
      <h2
        ref={heading}
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t(`platform.create.step.${step}`)}
      </h2>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {/* Enter presses the form's submit button: on the first two steps that is Next, which
          checks the step and goes on. Only the last step creates. */}
      <Form
        form={form}
        onSubmit={(values) => (last ? onSubmit(values) : undefined)}
        className="flex max-w-xl flex-col gap-4"
      >
        {step === 'identity' && <IdentityStep />}
        {step === 'locale' && <LocaleStep />}
        {step === 'modules' && (
          <>
            <ModulesStep />
            <Review />
          </>
        )}
        <div className="flex flex-wrap gap-3">
          {index > 0 && (
            <Button
              type="button"
              variant="outline"
              aria-disabled={pending || undefined}
              onClick={() => !pending && setIndex(index - 1)}
            >
              {t('platform.create.back')}
            </Button>
          )}
          {last ? (
            <SubmitButton pending={pending}>{t('platform.create.submit')}</SubmitButton>
          ) : (
            <Button
              type="submit"
              onClick={(event) => {
                event.preventDefault();
                void next();
              }}
            >
              {t('platform.create.next')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            aria-disabled={pending || undefined}
            onClick={() => !pending && onCancel()}
          >
            {t('platform.create.cancel')}
          </Button>
        </div>
      </Form>
    </div>
  );
}
