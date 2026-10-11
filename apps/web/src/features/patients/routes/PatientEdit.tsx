import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { useFormatters } from '@/tenancy';
import { PatientForm, type PatientFormHints } from '../components/PatientForm';
import { usePatient } from '../hooks/use-patient';
import {
  usePatientDraft,
  usePatientSaving,
  useUpdatePatient,
  type PatientDraft,
} from '../hooks/use-update-patient';
import type { PatientFormValues } from '../schemas';
import type { PatientRecord, PatientUpdate } from '../types';

/** Contact details: shown, and sent, only to a role that may see them. */
const CONTACT_FIELDS = ['phone', 'email', 'address'] as const;
const PLAIN_FIELDS = ['firstName', 'lastName', 'dob', 'gender'] as const;
const FIELDS = [...PLAIN_FIELDS, ...CONTACT_FIELDS, 'contactConsent'] as const;
type Field = (typeof FIELDS)[number];
type Changes = Omit<PatientUpdate, 'expectedVersion'>;

/** The record as the form holds it: every field a string, a missing one empty. */
function toValues(record: PatientRecord, contact: boolean): PatientFormValues {
  return {
    firstName: record.firstName,
    lastName: record.lastName,
    dob: record.dob,
    gender: record.gender,
    // Without the permission the phone is a mask, not a number: it is neither shown nor sent.
    phone: contact ? record.phone : '',
    email: contact ? (record.email ?? '') : '',
    address: contact ? (record.address ?? '') : '',
    contactConsent: record.contactConsent?.given ?? false,
  };
}

/** Only what differs from the record is sent, so two people changing different fields both keep theirs. */
function changesFrom(values: PatientFormValues, record: PatientRecord, contact: boolean): Changes {
  const before = toValues(record, contact);
  const changes: Changes = {};
  for (const field of PLAIN_FIELDS) {
    if (values[field] !== before[field]) Object.assign(changes, { [field]: values[field] });
  }
  if (contact) {
    if (values.phone !== before.phone) changes.phone = values.phone;
    // An emptied optional field is cleared on the record.
    if (values.email !== before.email) changes.email = values.email || null;
    if (values.address !== before.address) changes.address = values.address || null;
  }
  if (values.contactConsent !== before.contactConsent) {
    changes.contactConsent = { given: values.contactConsent };
  }
  return changes;
}

/** The record as it will read once the changes are saved, to show at once. */
function applied(record: PatientRecord, changes: Changes): PatientRecord {
  const { email, address, contactConsent, ...plain } = changes;
  const next: PatientRecord = { ...record, ...plain };
  if (email !== undefined) {
    if (email === null) delete next.email;
    else next.email = email;
  }
  if (address !== undefined) {
    if (address === null) delete next.address;
    else next.address = address;
  }
  if (contactConsent) {
    // When and by whom are the server's to say: shown as recorded now until it answers.
    next.contactConsent = {
      given: contactConsent.given,
      at: new Date().toISOString(),
      recordedBy: record.contactConsent?.recordedBy ?? '',
    };
  }
  return next;
}

/**
 * An unsaved edit, carried over to the record as it is now.
 *
 * A field the person did not touch takes the record's current value, so sending the edit again
 * cannot undo what someone else saved in the meantime. A field they did change keeps what they
 * typed, and is named as needing a look when someone else changed it too.
 *
 * Contact fields typed while the person could not see contact details were empty because they
 * were hidden, not cleared: they are never carried over.
 */
function rebase(
  draft: PatientDraft,
  record: PatientRecord,
  contact: boolean,
): { values: PatientFormValues; contested: Field[] } {
  const was = toValues(draft.base, draft.contact);
  const now = toValues(record, contact);
  const values = { ...now };
  const contested: Field[] = [];
  for (const field of FIELDS) {
    const isContact = (CONTACT_FIELDS as readonly string[]).includes(field);
    if (isContact && draft.contact !== contact) continue;
    const typed = draft.values[field];
    if (typed === was[field]) continue;
    Object.assign(values, { [field]: typed });
    if (now[field] !== was[field] && now[field] !== typed) contested.push(field);
  }
  return { values, contested };
}

interface EditFormProps {
  record: PatientRecord;
  draft: PatientDraft | null;
  saving: boolean;
  onDiscard: () => void;
}

/**
 * The form, working from the record and the unsaved edit as they were when it opened. They are
 * held here, not read live: a refresh of the record in the background must not change what the
 * person is typing over, or which version their save is checked against. If the record has moved
 * on by the time they save, the server says so and the conflict is handled then.
 */
function EditForm({ record: latest, draft: unsaved, saving, onDiscard }: EditFormProps) {
  const { t } = useTranslation('patients');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const format = useFormatters();
  const contact = usePermission('patient.contact:read');
  const update = useUpdatePatient(latest.id);
  const [record] = useState(latest);
  const [draft] = useState(unsaved);
  const [start] = useState(() =>
    draft ? rebase(draft, record, contact) : { values: toValues(record, contact), contested: [] },
  );

  // After someone else's save: what each field both people changed holds now.
  const now = toValues(record, contact);
  const hints: PatientFormHints = {};
  for (const field of start.contested) {
    if (field === 'contactConsent') {
      hints.contactConsent = t(now.contactConsent ? 'edit.nowAgreed' : 'edit.nowDeclined');
      continue;
    }
    const value =
      field === 'gender'
        ? t(`gender.${now.gender}`)
        : field === 'dob'
          ? format.date(`${now.dob}T12:00:00Z`)
          : now[field];
    hints[field] = value ? t('edit.nowSaved', { value }) : t('edit.nowCleared');
  }

  const back = `/patients/${record.id}`;

  const save = (values: PatientFormValues) => {
    // One save at a time for a record: a second would be checked against a version that the
    // first is about to change.
    if (saving) return;
    const changes = changesFrom(values, record, contact);
    // Nothing differs from the record: there is nothing to save, and nothing left to review.
    if (Object.keys(changes).length === 0) {
      onDiscard();
      void navigate(back);
      return;
    }
    update.mutate({
      body: { expectedVersion: record.version, ...changes },
      optimistic: applied(record, changes),
      draft: { values, base: record, contact },
    });
    void navigate(back);
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight break-words">
          {t('edit.heading', { name: `${record.firstName} ${record.lastName}` })}
        </h1>
        <p className="text-muted-foreground">{t('edit.description', { mrn: record.mrn })}</p>
      </div>

      {draft?.failure && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {draft.failure.conflict
            ? t(start.contested.length > 0 ? 'edit.conflictContested' : 'edit.conflict')
            : t('edit.notSaved', { reason: tCommon(draft.failure.messageKey) })}
        </p>
      )}
      {!contact && <p className="text-sm text-muted-foreground">{t('edit.contactRestricted')}</p>}

      <PatientForm
        onSubmit={save}
        pending={saving}
        initialValues={start.values}
        withContact={contact}
        hints={hints}
        submitLabel={t('edit.submit')}
      />
      <Link
        to={back}
        className="inline-flex items-center self-start rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
      >
        {t('edit.cancel')}
      </Link>
    </div>
  );
}

/**
 * Changing a patient's registration details. Saving goes straight back to the record, which
 * shows the change at once. If the server refuses, the record goes back to what it was and the
 * typing is kept (see `useUpdatePatient`), and this screen opens again with it.
 *
 * When the refusal is because someone else changed the record first, the edit is carried over to
 * their version: untouched fields take what they saved, and a field both people changed keeps
 * what was typed here and says what it now holds.
 */
export default function PatientEdit() {
  const { t } = useTranslation('patients');
  const { t: tCommon } = useTranslation();
  const { id = '' } = useParams();
  const patient = usePatient(id);
  const { draft, discard } = usePatientDraft(id);
  const saving = usePatientSaving(id);
  const record = patient.data;

  // After a conflict the record is being read again: wait for it, so the edit is carried over to
  // what was really saved and not to the copy that was just refused.
  const rereading = draft?.failure?.conflict === true && patient.isFetching;
  if (patient.isPending || rereading) return <PageSkeleton label={t('detail.loading')} />;

  if (!record) {
    const notFound = isApiError(patient.error) && patient.error.code === 'not_found';
    return (
      <SystemPage
        alert={!notFound}
        title={t(notFound ? 'detail.notFoundTitle' : 'detail.errorTitle')}
        description={notFound ? t('detail.notFoundBody') : tCommon(errorMessageKey(patient.error))}
        actions={
          <Link to="/patients" className="text-sm font-medium underline">
            {t('created.backToList')}
          </Link>
        }
      />
    );
  }

  // Keyed by the patient, so opening another patient's edit starts a fresh form.
  return (
    <EditForm key={record.id} record={record} draft={draft} saving={saving} onDiscard={discard} />
  );
}
