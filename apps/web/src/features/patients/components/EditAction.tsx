import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SlotProps } from '@/registry';
import { buttonVariants } from '@/shared/ui/button';
import { usePatientDraft, usePatientSaving } from '../hooks/use-update-patient';

/**
 * The Edit button on the patient screen. Contributed through the `patient.detail.actions` slot
 * like any other feature's action, so the screen itself does not know about editing. The manifest
 * offers it only to roles that hold `patient:update`.
 */
export default function EditAction({ context }: SlotProps) {
  const { t } = useTranslation('patients');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  const saving = usePatientSaving(patientId);
  const { draft } = usePatientDraft(patientId);
  // Whether the save that ended while this was shown went through, decided when it ends: a refused
  // one leaves a failed draft (the screen's alert says that one), and discarding that draft later
  // must never turn it into "saved". Followed during render, as React recommends for a value
  // that depends on the previous one.
  const [wasSaving, setWasSaving] = useState(saving);
  const [savedOne, setSavedOne] = useState(false);
  if (saving !== wasSaving) {
    setWasSaving(saving);
    setSavedOne(!saving && !draft?.failure);
  }
  if (!patientId) return null;
  const saved = savedOne && !draft?.failure;
  return (
    <>
      {/* Always there, so a screen reader reads what is put in it; empty, it takes no room. */}
      <span role="status" className="self-center text-sm text-muted-foreground empty:sr-only">
        {saving ? t('edit.saving') : saved ? t('edit.saved') : ''}
      </span>
      {/* One save at a time: the next edit has to start from the version this one produces. */}
      {!saving && (
        <Link to={`/patients/${patientId}/edit`} className={buttonVariants({ variant: 'outline' })}>
          {t('edit.action')}
        </Link>
      )}
    </>
  );
}
