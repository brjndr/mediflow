import { useTranslation } from 'react-i18next';
import type { DoctorOption } from '@/features/doctors';
import { MAX_SIDE_BY_SIDE } from '../hooks/use-calendar-appointments';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const field = 'flex min-w-52 flex-col gap-1 text-sm font-medium';

interface Props {
  /** Null while the departments are not available to this person: every doctor is offered. */
  departments: { id: string; name: string }[] | null;
  departmentId: string;
  onDepartment: (id: string) => void;
  /** The doctors of the chosen department. */
  doctors: DoctorOption[];
  /** The ones drawn: all of them up to eight, else the ones chosen. */
  shown: string[];
  onToggle: (doctorId: string) => void;
}

/**
 * Which doctors the day is drawn for: a department, then, when it has more than eight, which
 * eight. The choice is made with checkboxes, never by dragging.
 */
export function DoctorsPicker({
  departments,
  departmentId,
  onDepartment,
  doctors,
  shown,
  onToggle,
}: Props) {
  const { t } = useTranslation('appointments');
  const tooMany = doctors.length > MAX_SIDE_BY_SIDE;
  return (
    <>
      {departments !== null && (
        <label className={field}>
          {t('doctorsDay.department')}
          <select
            value={departmentId}
            onChange={(event) => onDepartment(event.target.value)}
            className={control}
          >
            <option value="">{t('doctorsDay.allDepartments')}</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {tooMany && (
        <fieldset className="flex min-w-0 basis-full flex-col gap-2">
          <legend className="text-sm font-medium">
            {t('doctorsDay.choose', { max: MAX_SIDE_BY_SIDE })}
          </legend>
          <p className="text-sm text-muted-foreground">
            {t('doctorsDay.tooMany', { count: doctors.length, max: MAX_SIDE_BY_SIDE })}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {doctors.map((doctor) => {
              const checked = shown.includes(doctor.id);
              const full = !checked && shown.length >= MAX_SIDE_BY_SIDE;
              return (
                <label
                  key={doctor.id}
                  className="flex min-h-6 items-center gap-2 text-sm pointer-coarse:min-h-11"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    // Not `disabled`: a full choice keeps focus, and says why it cannot grow.
                    aria-disabled={full || undefined}
                    onChange={() => !full && onToggle(doctor.id)}
                    className="size-4 pointer-coarse:size-5"
                  />
                  {doctor.name}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
    </>
  );
}
