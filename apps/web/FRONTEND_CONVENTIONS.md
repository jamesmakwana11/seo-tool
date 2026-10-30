# Frontend conventions — DeoDap SEO Sentinel (apps/web)

Read this before writing any screen. Reference implementations to copy patterns from:
`src/pages/DashboardPage.tsx`, `src/pages/issues/IssuesBoardPage.tsx`, `src/pages/issues/IssueDetailPage.tsx`, `src/pages/auth/LoginPage.tsx`.

## Stack
React 18 + TypeScript (strict) + react-router v6 + @tanstack/react-query v5 + Tailwind 3 + recharts + lucide-react.
Domain types, rules and the API contract come from `@sentinel/shared` (packages/shared/src). Path alias `@/` → `apps/web/src`.

## Data access — never import seed data into a page
- Always go through the API contract: `import { api } from '@/api/client'` (type `SentinelApi` in `packages/shared/src/api.ts`).
- Queries: `useApiQuery(key, () => api.x())` from `@/api/hooks`. Render with `<Async q={q}>{(data) => …}</Async>` which provides
  skeleton loading, error + Retry, and optional empty state. Use query keys that match existing invalidations:
  `['issues', …]`, `['issue', id]`, `['tasks', …]`, `['task', id]`, `['dashboard']`, `['module', m]`, `['crawls']`, `['crawl', id]`,
  `['config']`, `['employees']`, `['notifications']`, `['rules']`, `['integrations']`, `['briefs']`, `['brief', id]`, `['opportunities']`,
  `['workload']`, `['allocations']`, `['audit', …]`, `['digest']`, `['verifications']`, `['exclusions']`, `['groups']`.
- Mutations: `useApiMutation(fn, { success: 'Message', invalidate: [[...keys]], onSuccess })`. It toasts success and API errors
  automatically. Use the exact verb in the button and the toast ("Save rule" → "Rule saved").
- Employee names: `useEmployees()` from `@/hooks/lookups` (`.name(id)`, `.list`, `.byId`).
- Current user / permissions: `useUser()`, `useAuth().can('perm')` from `@/auth/AuthContext`. Hide or disable controls the user
  can't use (disabled + `title` explaining why). The API re-checks every permission — UI hiding is convenience only.

## Components (reuse — do not re-implement)
- `@/components/ui/primitives`: `Button` (variants primary/secondary/ghost/danger/subtle, `loading`, `icon`), `IconButton`, `Panel`
  (title/subtitle/actions), `PageHeader` (title/description/meta/actions), `Stat`, `Badge` (tones), `SampleBadge`, `Field`, `Input`,
  `Textarea`, `Select`, `Checkbox`, `Toggle`, `ProgressBar`, `Skeleton`, `LoadingBlock`, `EmptyState`, `ErrorState`, `Async`, `Tabs`,
  `KV`, `Code`, `Mono`, `Notice` (tones neutral/caution/crit/med/signal).
- `@/components/ui/overlay`: `Dialog`, `Drawer`, `ConfirmDialog` (supports required/optional reason), `Menu`.
- `@/components/ui/DataTable`: sortable, searchable, paginated table (client or `server` paging); `onRowClick` for drill-down.
- `@/components/ui/filters`: `ChipGroup`, `FilterSelect`, `ClearFilters`, `useUrlFilters` (filters live in the URL).
- `@/components/ui/charts`: `TrendChart`, `StackedBars`, `Sparkline`, `SERIES` colours.
- `@/components/domain/badges`: `SeverityBadge`, `IssueStatusBadge`, `TaskStatusBadge`, `TeamBadge`, `TierBadge`, `RoleBadge`,
  `PriorityBadge`, `DeltaBadge`, `SourceBadge` (sample/simulated/manual/live), `SlaCountdown`.
- `@/components/domain/*`: `FixCardView`, `AllocationButtons` + `AllocationTrail`, `IssueTable`, `TaskActions` + `TaskCard`,
  `UrlList`, `EvidenceList`, `ActivityTimeline`, `HealthDial`, `ModuleScoreList`, `ModuleView` (+ `CheckTable`, `ModuleLinkCards`, `useModule`).
- Formatting: `@/lib/format` (`fmtDate`, `fmtDateTime` (IST), `fmtRelative`, `fmtNum` (en-IN), `fmtPct`, `fmtMs`, `shortUrl`, `downloadText`).
- If you need a new reusable component, put it in your own area folder (e.g. `src/components/tasks/…`). Do **not** edit files you
  were not assigned — other agents are working in parallel.

## Honesty rules (non-negotiable — prompt §1.3, §7.2)
- Records with `source` show `<SourceBadge>`; simulated data shows `<SampleBadge />`.
- Never present simulated/sample results as live, delivered, connected or verified. When the API returns `available:false`,
  `outcome:'pending_data'`, `skipped_not_configured`, `not_configured`, `evaluated:false`, render that state plainly and say what is
  needed (e.g. "Requires Ahrefs or Semrush API").
- A task in FIXED is "awaiting automated re-verification", not verified.
- Sentinel never changes the live site; proposals need human approval (PDF §17) — say so on approval actions.

## Design
- Calm canvas `bg-canvas`, white `Panel`s, ink text; severity colours (crit/med/low/opp/ok) are the only loud colours.
  Accent is `signal` (teal). Typeface IBM Plex Sans; `font-mono` only for URLs, IDs, code.
- Sentence case everywhere. No ALL-CAPS labels, no decorative eyebrows, no gradients, no emoji in UI chrome.
- Information-dense: tables over card grids where the content is tabular. Use `grid gap-5` between panels, `space-y-5` stacks.
- Responsive: must work at 390px, 768px, 1440px. Tables scroll horizontally (DataTable does this); use `hideOnMobile` on secondary
  columns; stack grids with `md:`/`xl:` breakpoints.
- Accessibility: every input has a label (`Field` + `htmlFor`), buttons have text or `aria-label`, toggles via `Toggle`,
  dialogs via `Dialog`/`ConfirmDialog` (focus-trapped). Validation messages via `Field error`.
- Every visible control must do something real through the API. No decorative buttons. If a capability genuinely doesn't exist,
  don't render a button for it — explain in text instead.
- Copy: plain verbs, say what happens ("Run dry run", "Mark not an issue"). Empty states tell the user what to do next.

## Each page file
`export default function XxxPage()`; keep page-specific subcomponents in the same file unless reused.
Start with `<PageHeader title description actions={…} />`.
Reference the PDF section in descriptions where it helps the team understand why the screen exists (e.g. "PDF §12.1").

## Checks before you finish
From `apps/web`: `npx tsc -p tsconfig.json --noEmit` and `npx eslint <your files> --max-warnings 0` must report **no errors in your
files** (other agents' in-progress files may briefly error — ignore those, never edit them).
