import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useDisableMfa, useRegenerateRecoveryCodes } from '../hooks/use-mfa';
import { mfaManageSchema, type MfaManageValues } from '../schemas';
import { RecoveryCodes } from './RecoveryCodes';

type Mode = 'idle' | 'regenerate' | 'disable';

function manageErrorKey(error: unknown): string {
  if (isApiError(error)) {
    if (error.serverCode === 'invalid_password') return 'security.wrongPassword';
    if (error.serverCode === 'invalid_mfa_code') return 'security.invalidAppCode';
    if (error.serverCode === 'mfa_required_here') return 'security.requiredHere';
  }
  return errorMessageKey(error);
}

/**
 * What a person with an authenticator can do to it: replace the recovery codes, or turn it off.
 * Each asks again for the password and a code from the app (a recovery code is not accepted, so
 * a lost phone's codes cannot undo the second step). A refused attempt clears both fields and
 * uses nothing up; the new recovery codes live only in the mutation result, gone with the screen.
 */
export function ManageAuthenticator({ onDisabled }: { onDisabled: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('idle');
  const regenerate = useRegenerateRecoveryCodes();
  const disable = useDisableMfa();
  const form = useZodForm(mfaManageSchema, { password: '', code: '' });

  const mutation = mode === 'disable' ? disable : regenerate;

  const open = (next: Mode) => {
    regenerate.reset();
    disable.reset();
    form.reset();
    setMode(next);
    // The form opens under the button that was pressed: the cursor goes to its first field.
    if (next !== 'idle') setTimeout(() => form.setFocus('password'), 0);
  };
  const close = () => {
    const back = mode === 'disable' ? 'security-turn-off' : 'security-regenerate';
    open('idle');
    // The form is gone: focus goes back to the button that opened it.
    setTimeout(() => document.getElementById(back)?.focus(), 0);
  };

  const onSubmit = async (values: MfaManageValues) => {
    try {
      if (mode === 'disable') {
        await disable.mutateAsync(values);
        onDisabled();
      } else {
        await regenerate.mutateAsync(values);
      }
      form.reset();
    } catch {
      // The message comes from the mutation's error below. Neither the password nor the code is
      // kept, and neither is used up by a refusal.
      form.reset();
      form.setFocus('password');
    }
  };

  if (regenerate.isSuccess) {
    return (
      <RecoveryCodes
        codes={regenerate.data}
        onDone={() => {
          regenerate.reset();
          close();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-sm">
        {t('security.enabled')}
      </p>
      {mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            id="security-regenerate"
            type="button"
            variant="outline"
            onClick={() => open('regenerate')}
          >
            {t('security.regenerate')}
          </Button>
          <Button
            id="security-turn-off"
            type="button"
            variant="outline"
            onClick={() => open('disable')}
          >
            {t('security.turnOff')}
          </Button>
        </div>
      ) : (
        <>
          <h2 className="text-lg font-semibold tracking-tight">
            {t(mode === 'disable' ? 'security.turnOff' : 'security.regenerate')}
          </h2>
          <p className="text-sm">
            {t(mode === 'disable' ? 'security.turnOffIntro' : 'security.regenerateIntro')}
          </p>
          {mutation.isError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {t(manageErrorKey(mutation.error))}
            </p>
          )}
          <Form form={form} onSubmit={onSubmit}>
            <TextField<MfaManageValues>
              name="password"
              label={t('login.password')}
              type="password"
              autoComplete="current-password"
              required
            />
            <TextField<MfaManageValues>
              name="code"
              label={t('security.codeLabel')}
              hint={t('security.appCodeHint')}
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              required
            />
            <div className="flex flex-wrap gap-2">
              <SubmitButton pending={mutation.isPending}>
                {t(mode === 'disable' ? 'security.turnOffConfirm' : 'security.regenerateConfirm')}
              </SubmitButton>
              <Button type="button" variant="ghost" onClick={close}>
                {t('security.cancel')}
              </Button>
            </div>
          </Form>
        </>
      )}
    </div>
  );
}
