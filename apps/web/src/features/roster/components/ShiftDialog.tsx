import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useDepartmentOptions } from '@/features/departments';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import {
  Form,
  SelectField,
  TextField,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { nextDay, zonedToUtc } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import { useCreateShift, useShiftTemplates } from '../hooks/use-roster';
import { SHIFT_KINDS, SHIFT_TEMPLATES, shiftFormSchema, type ShiftFormValues } from '../schemas';
import type { RosterShift, ShiftKind, ShiftTemplate } from '../types';
import { PersonField } from './PersonField';

const REFUSED: Record<string, string> = {
  shift_overlap: 'errors.overlap',
  invalid_period: 'errors.period',
  unknown_user: 'errors.user',
  unknown_department: 'errors.department',
  on_leave: 'errors.onLeave',
};

/**
 * Fills the times from the built-in hours of the chosen kind of shift, when the kind changes. A
 * hospital's own template, once chosen, has set the hours already and is not overwritten.
 */
function KindTimes() {
  const kind = useFieldValue('shiftKind') as ShiftKind;
  const templateId = useFieldValue('templateId') as string;
  const setValue = useSetFieldValue();
  const first = useRef(true);
  const chosen = useRef(templateId);
  useEffect(() => {
    chosen.current = templateId;
  }, [templateId]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (chosen.current !== '') return;
    setValue('startTime', SHIFT_TEMPLATES[kind].start);
    setValue('endTime', SHIFT_TEMPLATES[kind].end);
  }, [kind, setValue]);
  return null;
}

/** Choosing one of the hospital's templates sets the kind, the department and the hours. */
function TemplateFill({ templates }: { templates: ShiftTemplate[] }) {
  const templateId = useFieldValue('templateId') as string;
  const setValue = useSetFieldValue();
  useEffect(() => {
    const chosen = templates.find((one) => one.id === templateId);
    if (!chosen) return;
    setValue('shiftKind', chosen.shiftKind);
    setValue('startTime', chosen.startTime);
    setValue('endTime', chosen.endTime);
    if (chosen.departmentId !== undefined) setValue('departmentId', chosen.departmentId);
  }, [templateId, templates, setValue]);
  return null;
}

/**
 * Puts a member of staff on duty (OP-01, #195). A template of the hospital (#592) or the kind of
 * shift fills the usual hours; an end at or before the start means the next morning. A person
 * already on duty then is refused by the server and said so here, with the choices kept.
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
  const templates = useShiftTemplates().data ?? [];
  const form = useZodForm(shiftFormSchema, {
    templateId: '',
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
        <KindTimes />
        <TemplateFill templates={templates} />
        <PersonField />
        {templates.length > 0 && (
          <SelectField<ShiftFormValues>
            name="templateId"
            label={t('new.template')}
            hint={t('new.templateHint')}
            placeholder={t('new.noTemplate')}
            options={templates.map((one) => ({
              value: one.id,
              label: t('templates.option', {
                name: one.name,
                start: one.startTime,
                end: one.endTime,
              }),
            }))}
          />
        )}
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
