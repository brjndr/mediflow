# Mediflow

Multi-tenant hospital management system for hospital staff: OPD, inpatient, emergency, diagnostics, pharmacy, billing, insurance and records, served to many hospitals from one deployment and one URL.

- **Project rules and architecture:** [`CLAUDE.md`](CLAUDE.md)
- **Roadmap (milestones and issues):** [`docs/ROADMAP.md`](docs/ROADMAP.md)
- **How we work with GitHub issues:** [`docs/WORKFLOW.md`](docs/WORKFLOW.md)
- **Prompts for Claude Code:** [`docs/CLAUDE_PROMPTS.md`](docs/CLAUDE_PROMPTS.md)

## Repository layout

```
apps/web/            React 18 SPA (Vite, Tailwind + shadcn/ui, React Query, MSW mock API)
apps/api/            Fastify API (arrives in milestone M1, issue BE-01)
packages/contract/   OpenAPI spec + generated TypeScript types shared by web and api
scripts/github/      Roadmap seeding and progress status
docs/  .claude/  .github/
```

## Run locally on Windows

Requirements: Node.js 22 LTS (22.13 or newer), Git, Docker Desktop (only needed once the API exists). WSL is not required.

```powershell
# Once per machine
corepack enable               # provides the pinned pnpm version

# Clone into a short path outside OneDrive
git clone https://github.com/brjndr/mediflow C:\dev\mediflow
cd C:\dev\mediflow
pnpm install

# Web app against the mock API (http://localhost:5173)
pnpm dev
```

Local services (Postgres, Mailpit; add `--profile full` for MinIO and Redis):

```powershell
Copy-Item .env.example .env
docker compose up -d
docker compose ps             # all services should be healthy
```

Mailpit UI: http://localhost:8025. Data lives in named Docker volumes and survives restarts. `docker compose down -v` deletes it.

## Commands

| Command          | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `pnpm dev`       | Vite dev server with the MSW mock API                           |
| `pnpm build`     | Type-check and production build of every package                |
| `pnpm lint`      | ESLint across the repo                                          |
| `pnpm typecheck` | TypeScript across the repo                                      |
| `pnpm test`      | Vitest (max 2 workers)                                          |
| `pnpm e2e`       | Playwright smoke tests (Chromium)                               |
| `pnpm analyze`   | Bundle report at `apps/web/stats.html`                          |
| `pnpm gen:api`   | Regenerate contract types from `packages/contract/openapi.json` |
| `pnpm format`    | Prettier                                                        |

First Playwright run on a new machine: `pnpm --filter web exec playwright install chromium`.

A pre-commit hook (simple-git-hooks + lint-staged) lints and formats staged files. Use **pnpm only**; npm, yarn and bun are blocked.

## UI components and theming

Components come from [shadcn/ui](https://ui.shadcn.com) and live in `apps/web/src/shared/ui`. Add one with:

```powershell
cd apps/web
pnpm dlx shadcn@latest add dialog
```

All colors and the radius are CSS variables in `apps/web/src/index.css`. Use token classes (`bg-primary`, `text-muted-foreground`) rather than raw colors, so each hospital's branding can re-theme the app at runtime through `applyTheme()` in `shared/lib/theme.ts`.

## Roadmap on GitHub

```powershell
gh auth login
node scripts/github/seed.mjs --dry-run   # preview labels, milestones and issues
node scripts/github/seed.mjs             # create them (idempotent)
node scripts/github/status.mjs           # progress per milestone
```
