import { useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getSession, loginFn } from '#/server/workflow.functions'
import { Card, ErrorText, Field, btnCls, inputCls } from '#/components/ui'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    if (await getSession()) throw redirect({ to: '/' })
  },
  component: Login,
})

const DEMO = ['frontdesk', 'nurse', 'doctor', 'billing', 'admin']

function Login() {
  const router = useRouter()
  const login = useServerFn(loginFn)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError(null)
    try {
      await login({ data: { username: String(f.get('username')), password: String(f.get('password')) } })
      await router.invalidate()
      await router.navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page-wrap px-4 py-14">
      <div className="mx-auto max-w-md">
        <h1 className="display-title mb-6 text-4xl font-bold text-[var(--sea-ink)]">MediFlow</h1>
        <Card title="Staff sign in">
          <form method="post" onSubmit={onSubmit} className="space-y-4">
            <Field label="Username">
              <input name="username" className={inputCls} autoComplete="username" required />
            </Field>
            <Field label="Password">
              <input name="password" type="password" className={inputCls} autoComplete="current-password" required />
            </Field>
            <ErrorText message={error} />
            <button className={btnCls} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </Card>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Demo only (fake data). Usernames: {DEMO.join(', ')} — password <code>mediflow-demo</code>.
        </p>
      </div>
    </main>
  )
}
