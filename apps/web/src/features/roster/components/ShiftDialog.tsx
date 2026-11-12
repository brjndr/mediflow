import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDepartmentOptions } from '@/features/departments';
import { StaffSearch } from '@/features/staff';
import { focusIfLost } from '@/shared/lib/focus';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import {
  Form,
  SelectField,
  TextField,
  useFieldError,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { nextDay, zonedToUtc } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import { useCreateShift } from '../hooks/use-roster';
import { SHIFT_KINDS, SHIFT_TEMPLATES, shiftFormSchema, type ShiftFormValues } from '../schemas';
import type { RosterShift, ShiftKind } from '../types';

const REFUSED: Record<string, string> = {
  shift_overlap: 'errors.overlap',
  invalid_period: 'errors.period',
  unknown_user: 'errors.user',
  unknown_department: 'errors.department',
};

/** Fills the times from the template of the chosen kind of shift, when the kind changes. */
function TemplateTimes() {
  const kind = useFieldValue('shiftKind') as ShiftKind;
  const setValue = useSetFieldValue();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setValue('startTime', SHIFT_TEMPLATES[kind].start);
    setValue('endTime', SHIFT_TEMPLATES[kind].end);
  }, [kind, setValue]);
  return null;
}

/**
 * The person on the shift, found by a search on the server (a hospital may have far more staff
 * than a list can hold). The chosen name stays shown, with a way to search again; the form holds
 * only the id.
 */
function PersonField() {
  const { t } = useTranslation('roster');
  const setValue = useSetFieldValue();
  const userId = useFieldValue('userId') as string;
  const error = useFieldError('userId');
  const [name, setName] = useState('');
  const empty = userId === '';
  const errorId = 'roster-person-error';
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);
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
          <p className="text-sm font-medium">{t('new.person')}</p>
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
          label={t('new.person')}
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

/**
 * Puts a member of staff on duty (OP-01, #195). The kind of shift fills the usual hours; an end
 * at or before the start means the next morning. A person already on duty then is refused by the
 * server and said so here, with the choices kept.
 */
export function ShiftDialog({
  day,
  onClose,
  onCreated,
}: {
  day: string;
  onClose: () => void;
  onCreated: (created: RosterShift) => void;
}) {
  const { t } = useTranslation('roster');
  const { t: tCommon } = useTranslation();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const create = useCreateShift();
  const departments = useDepartmentOptions();
  const form = useZodForm(shiftFormSchema, {
    userId: '',
    departmentId: '',
    shiftKind: 'morning',
    day,
    startTime: SHIFT_TEMPLATES.morning.start,
    endTime: SHIFT_TEMPLATES.morning.end,
  });
  const code = isApiError(create.error) ? create.error.serverCode : undefined;
  const failure = !create.error
    ? undefined
    : code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(create.error));

  const submit = async (values: ShiftFormValues) => {
    const endDay = values.endTime > values.startTime ? values.day : nextDay(values.day);
    try {
      onCreated(
        await create.mutateAsync({
          userId: values.userId,
          ...(values.departmentId !== '' ? { departmentId: values.departmentId } : {}),
          shiftKind: values.shiftKind,
          startsAt: zonedToUtc(values.day, values.startTime, timezone),
          endsAt: zonedToUtc(endDay, values.endTime, timezone),
        }),
      );
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('new.title')}
      description={t('new.description')}
      closeLabel={t('close')}
      busy={create.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="roster-shift-form" aria-busy={create.isPending}>
            {create.isPending ? t('new.saving') : t('new.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="roster-shift-form" onSubmit={submit}>
        <TemplateTimes />
        <PersonField />
        {departments.available && (
          <SelectField<ShiftFormValues>
            name="departmentId"
            label={t('new.department')}
            placeholder={t('new.anyDepartment')}
            options={(departments.data ?? []).map((one) => ({ value: one.id, label: one.name }))}
          />
        )}
        <SelectField<ShiftFormValues>
          name="shiftKind"
          label={t('new.kind')}
          hint={t('new.kindHint')}
          required
          options={SHIFT_KINDS.map((value) => ({ value, label: t(`kind.${value}`) }))}
        />
        <TextField<ShiftFormValues> name="day" type="date" label={t('new.day')} required />
        <TextField<ShiftFormValues> name="startTime" type="time" label={t('new.start')} required />
        <TextField<ShiftFormValues>
          name="endTime"
          type="time"
          label={t('new.end')}
          hint={t('new.endHint')}
          required
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
