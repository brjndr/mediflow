import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, TextAreaField, useZodForm } from '@/shared/ui/form';
import { ExamplePage } from '../components/ExamplePage';

const schema = z.object({ reason: z.string().trim().min(1, 'validation.required').max(300) });

/** A short form in a dialog: the footer's button submits it by its `form` attribute. */
function ReasonDialog({ open, onClose }: { open: boolean; onClose: (reason?: string) => void }) {
  const { t } = useTranslation('ui_examples');
  const form = useZodForm(schema, { reason: '' });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('dialog.formTitle')}
      description={t('dialog.formDescription')}
      closeLabel={t('dialog.close')}
      footer={<FormFooter onCancel={() => onClose()} />}
    >
      <Form form={form} id="reason-form" onSubmit={(values) => onClose(values.reason)}>
        <TextAreaField name="reason" label={t('dialog.reason')} required />
      </Form>
    </Dialog>
  );
}

function FormFooter({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation('ui_examples');
  return (
    <>
      <Button variant="outline" onClick={onCancel}>
        {t('dialog.cancel')}
      </Button>
      <Button type="submit" form="reason-form">
        {t('dialog.save')}
      </Button>
    </>
  );
}

export default function DialogExample() {
  const { t } = useTranslation('ui_examples');
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState('');

  return (
    <ExamplePage heading={t('dialog.heading')}>
      <p className="text-muted-foreground">{t('dialog.intro')}</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setConfirming(true)}>{t('dialog.openConfirm')}</Button>
        <Button variant="outline" onClick={() => setAsking(true)}>
          {t('dialog.openForm')}
        </Button>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {result}
      </p>

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('dialog.confirmTitle')}
        description={t('dialog.confirmDescription')}
        closeLabel={t('dialog.close')}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                setResult(t('dialog.confirmed'));
              }}
            >
              {t('dialog.confirm')}
            </Button>
          </>
        }
      />
      <ReasonDialog
        open={asking}
        onClose={(reason) => {
          setAsking(false);
          if (reason) setResult(t('dialog.saved', { reason }));
        }}
      />
    </ExamplePage>
  );
}
