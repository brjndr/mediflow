import { Link, Outlet, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getSession, logoutFn } from '#/server/workflow.functions'
import ThemeToggle from '#/components/ThemeToggle'
import { btnGhostCls } from '#/components/ui'

// Route guard is UX only; every server function enforces auth/roles itself.
export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const user = await getSession()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  component: AppLayout,
})

function AppLayout() {
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const logout = useServerFn(logoutFn)

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 backdrop-blur-lg">
        <nav className="page-wrap flex flex-wrap items-center gap-4 py-3">
          <span className="text-base font-bold text-[var(--sea-ink)]">MediFlow</span>
          <Link to="/" className="nav-link" activeProps={{ className: 'nav-link is-active' }} activeOptions={{ exact: true }}>
            Worklist
          </Link>
          <Link to="/patients" className="nav-link" activeProps={{ className: 'nav-link is-active' }}>
            Patients
          </Link>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-[var(--sea-ink-soft)]">
              {user.name} · {user.role}
            </span>
            <ThemeToggle />
            <button
              className={btnGhostCls}
              onClick={async () => {
                await logout()
                await router.invalidate()
                await router.navigate({ to: '/login' })
              }}
            >
              Sign out
            </button>
          </div>
        </nav>
      </header>
      <Outlet />
    </>
  )
}
