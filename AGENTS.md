# MediFlow — Hospital Management System

Durable project context for humans and AI agents. Keep this file up to date.

## Scaffolding commands (exact)

```bash
# Run in a scratch directory, then merged into this repo (repo already had a README + git history)
npx @tanstack/cli@latest create my-tanstack-app --agent --package-manager pnpm --tailwind --add-ons tanstack-query

# Follow-up TanStack Intent commands (run from repo root)
npx @tanstack/intent@latest install   # needs an interactive terminal to confirm permissions (see gotchas)
npx @tanstack/intent@latest list      # lists skills shipped by installed packages
pnpm exec intent load <package>#<skill>   # load a specific skill before using that library
```

The generated project was copied to the repo root; `package.json` name and `.cta.json` projectName were renamed from `my-tanstack-app` to `mediflow`. Nothing else was altered.

## Stack

- React 19 + TanStack Start (SSR, Vite 8) + TanStack Router (file-based, `src/routes`, generated `src/routeTree.gen.ts`)
- TanStack Query add-on (`src/integrations/tanstack-query/`, SSR-Query integration wired in `src/router.tsx`)
- Tailwind CSS v4 (`@tailwindcss/vite`, `src/styles.css`), TypeScript 6
- Toolchain: default CLI toolchain (no ESLint/Prettier/Vitest added), pnpm, `#/*` import alias -> `src/*`
- Blank starter: demo content in `src/routes/demo/` and `about.tsx` can be deleted once real features exist.

## Scripts

`pnpm dev` (port 3000) · `pnpm build` · `pnpm preview` · `pnpm generate-routes`

## Environment variables

None required by the scaffold. Client-exposed vars must be prefixed `VITE_`; server-only vars use `process.env` inside server functions. `.env` is git-ignored. When a database/auth is added, document vars here (e.g. `DATABASE_URL`, `SESSION_SECRET`).

## Deployment notes

No deploy target is chosen yet. TanStack Start supports Node, Netlify, Vercel, Cloudflare, Bun, etc. — load the skill `@tanstack/start-client-core#start-core/deployment` before choosing and adding the adapter/plugin.

## Architectural decisions

- Keep generated structure; add domain features as routes under `src/routes/` (e.g. `patients`, `appointments`, `staff`, `billing`) and data access through `createServerFn` + TanStack Query (`queryOptions`) with loaders prefetching via the router's query client.
- Before library-specific changes, run `pnpm exec intent list` and load the relevant skill (router-core, start-core, server-functions, middleware, auth-server-primitives, etc.).

## Known gotchas

- `intent install` run non-interactively prints `intent.skills is not configured` — run it in an interactive terminal to confirm permissions. `intent list` still works.
- `src/routeTree.gen.ts` is generated and git-ignored; run `pnpm dev`/`pnpm generate-routes` before typechecking in a fresh clone.
- `pnpm-workspace.yaml` holds pnpm `onlyBuiltDependencies` settings; keep it.
- Hospital data is PHI: no real patient data in dev; plan auth, audit logging and encryption before any persistence.

## Next steps

1. Run `npx @tanstack/intent@latest install` interactively and commit its result (agent config/`intent.skills`).
2. Choose database/ORM and auth; add env var docs above.
3. Model domain: patients, staff, appointments, wards/beds, prescriptions, billing.
4. Replace demo routes/home page with a dashboard shell; add role-based route guards (`router-core/auth-and-guards`).
5. Add lint/format/test tooling if wanted (CLI add-ons) and CI.
6. Pick deployment target.
