import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, TextField, useZodForm } from '@/shared/ui/form';
import { useCreateRoom, useUpdateRoom } from '../hooks/use-theatre';
import { roomFormSchema, type RoomFormValues } from '../schemas';
import type { OtRoom } from '../types';

/** Adds a theatre, or renames the one given. */
export function RoomDialog({
  room,
  onClose,
  onSaved,
}: {
  room?: OtRoom;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  const create = useCreateRoom();
  const update = useUpdateRoom();
  const form = useZodForm(roomFormSchema, { name: room?.name ?? '' });
  const error = create.error ?? update.error;
  const busy = create.isPending || update.isPending;
  const failure = !error
    ? undefined
    : isApiError(error) && error.serverCode === 'name_taken'
      ? t('errors.roomName')
      : isApiError(error) && error.serverCode === 'version_conflict'
        ? t('errors.changed')
        : tCommon(errorMessageKey(error));

  const submit = async (values: RoomFormValues) => {
    try {
      const saved = room
        ? await update.mutateAsync({ room, name: values.name })
        : await create.mutateAsync({ name: values.name });
      onSaved(saved.name);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={room ? t('room.renameTitle') : t('room.addTitle')}
      closeLabel={t('close')}
      busy={busy}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="theatre-room-form" aria-busy={busy}>
            {busy ? t('room.saving') : t('room.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="theatre-room-form" onSubmit={submit}>
        <TextField<RoomFormValues> name="name" label={t('room.name')} required />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
