import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SubmitButton, useZodForm } from '@/shared/ui/form';
import { DrugFields } from '../components/DrugFields';
import { useCheckDrugDuplicates, useCreateDrug } from '../hooks/use-drugs';
import { drugFormSchema, toCreate, toFormValues, type DrugFormValues } from '../schemas';
import type { Drug } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** What tells two similar items apart, on one line. */
function Identity({ drug }: { drug: Drug }) {
  const { t } = useTranslation('drugs');
  return (
    <>
      <span className="font-medium">{drug.genericName}</span>
      <span className="block text-muted-foreground">
        {[
          drug.brandName,
          t(`forms.${drug.form}`),
          drug.strength,
          drug.archived && t('duplicates.archived'),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </>
  );
}

/** Items like the one being added, and the choice to add it all the same. */
function DuplicateWarning({
  matches,
  pending,
  onAddAnyway,
  onBack,
}: {
  matches: Drug[];
  pending: boolean;
  onAddAnyway: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('drugs');
  const heading = useRef<HTMLHeadingElement>(null);
  // It replaces the form: take the keyboard, and a screen reader, to what it says.
  useEffect(() => heading.current?.focus(), []);
  return (
    <section aria-labelledby="drug-duplicates" className="flex max-w-xl flex-col gap-3">
      <h2 id="drug-duplicates" ref={heading} tabIndex={-1} className="text-lg font-semibold">
        {t('duplicates.heading', { count: matches.length })}
      </h2>
      <p className="text-sm text-muted-foreground">{t('duplicates.description')}</p>
      <ul className="flex flex-col gap-2">
        {matches.map((match) => (
          <li key={match.id} className="rounded-md border p-3 text-sm">
            <Identity drug={match} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button disabled={pending} aria-busy={pending} onClick={onAddAnyway}>
          {t('duplicates.addAnyway')}
        </Button>
        <Button variant="outline" disabled={pending} onClick={onBack}>
          {t('duplicates.back')}
        </Button>
      </div>
    </section>
  );
}

function NewDrug() {
  const { t } = useTranslation('drugs');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const check = useCheckDrugDuplicates();
  const create = useCreateDrug();
  const form = useZodForm(drugFormSchema, toFormValues());
  // What was filled in, while the person looks at the possible duplicates.
  const [held, setHeld] = useState<DrugFormValues | null>(null);
  const [matches, setMatches] = useState<Drug[] | null>(null);
  // Leaving the screen (Cancel, the back button) while the check is on its way ends the attempt:
  // nothing is added behind the person's back.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);

  const add = async (values: DrugFormValues) => {
    try {
      const drug = await create.mutateAsync(toCreate(values));
      if (!here.current) return;
      await navigate(`/drugs/${drug.id}`, { replace: true });
    } catch {
      // Shown from the mutation state below. Back to the form, with what was typed.
      setMatches(null);
    }
  };

  const submit = async (values: DrugFormValues) => {
    check.reset();
    create.reset();
    setHeld(values);
    try {
      const found = await check.mutateAsync({ genericName: values.genericName, form: values.form });
      if (!here.current) return;
      if (found.length > 0) return setMatches(found);
      await add(values);
    } catch {
      // A failed check stops the item being added: shown from the mutation state below.
    }
  };

  const error = check.error ?? create.error;
  const exists = isApiError(create.error) && create.error.serverCode === 'drug_exists';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('create.heading')}</h1>
        <p className="text-muted-foreground">{t('create.description')}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {exists ? t('create.exists') : tCommon(errorMessageKey(error))}
        </p>
      )}

      {matches && held ? (
        <DuplicateWarning
          matches={matches}
          pending={create.isPending}
          onAddAnyway={() => void add(held)}
          onBack={() => setMatches(null)}
        />
      ) : (
        <Form form={form} onSubmit={submit} className="flex max-w-xl flex-col gap-4">
          <DrugFields />
          <div className="flex flex-wrap gap-3">
            <SubmitButton pending={check.isPending || create.isPending}>
              {t('create.submit')}
            </SubmitButton>
            <Link to="/drugs" className={link}>
              {t('form.cancel')}
            </Link>
          </div>
        </Form>
      )}
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function DrugCreate() {
  return (
    <DesktopOnly>
      <NewDrug />
    </DesktopOnly>
  );
}
