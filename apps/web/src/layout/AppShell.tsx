import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Bell, ChevronDown, ChevronsLeft, ChevronsRight, LogOut, Menu as MenuIcon, Search, User, X, Eye } from 'lucide-react';
import { WebsiteProvider } from '@/websites/WebsiteContext';
import { WebsiteSelector } from '@/components/websites/WebsiteSelector';
import { ROLE_LABELS, type Role, type SearchResult } from '@sentinel/shared';
import { useAuth, useUser } from '@/auth/AuthContext';
import { api, API_MODE } from '@/api/client';
import { useApiQuery, useWebsiteId } from '@/api/hooks';
import { isActive, visibleNav } from './nav';
import { Menu } from '@/components/ui/overlay';
import { RoleBadge } from '@/components/domain/badges';

const CRUMB: Record<string, string> = {
  health: 'Health Score', issues: 'Issues', websites: 'Websites', overview: 'All websites',
  verification: 'Verification', pages: 'All pages', report: 'Page report', images: 'Image Audit', modules: 'Audit modules', technical: 'Technical SEO', crawlability: 'Crawlability & indexability', responses: 'Response codes & links',
  canonicals: 'Canonicals & duplication', security: 'Security, mobile & rendering', 'structured-data': 'Structured data', performance: 'Performance & CWV',
  content: 'Content', onpage: 'On-page', offpage: 'Off-page', backlinks: 'Backlinks', aeo: 'AEO', geo: 'GEO', 'ai-compliance': 'AI content compliance',
  'ai-visibility': 'AI visibility', crawls: 'Crawl Center', groups: 'Template-level issues', exclusions: 'Exclusions', opportunities: 'Opportunities',
  keywords: 'Keyword research', gaps: 'Keyword gaps', briefs: 'Content briefs', clusters: 'Topic clusters', seasonal: 'Seasonal planner',
  'link-building': 'Digital PR & links', mentions: 'Brand mentions', competitors: 'Competitors', reports: 'Reports', daily: 'Daily digest',
  weekly: 'Weekly rollup', monthly: 'Monthly executive', history: 'History', team: 'Team', employees: 'Employees', roles: 'Roles & permissions',
  allocations: 'Allocation history', settings: 'Settings', integrations: 'Integrations', thresholds: 'Thresholds & scoring', crawl: 'Crawl configuration',
  notifications: 'Notifications', rules: 'Custom rules', audit: 'Audit log', system: 'System health', diagnostics: 'API diagnostics', profile: 'Profile', search: 'Search',
};

function Breadcrumbs() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return <span className="text-sm font-medium text-ink">Dashboard</span>;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
      <Link to="/" className="text-muted hover:text-ink">Dashboard</Link>
      {parts.map((p, i) => {
        const href = `/${parts.slice(0, i + 1).join('/')}`;
        const last = i === parts.length - 1;
        const label = CRUMB[p] ?? decodeURIComponent(p);
        return (
          <span key={href} className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-line-strong" aria-hidden>/</span>
            {last || !CRUMB[p] ? <span className={clsx('truncate', last ? 'font-medium text-ink' : 'text-muted')} aria-current={last ? 'page' : undefined}>{label}</span> : <Link to={href} className="truncate text-muted hover:text-ink">{label}</Link>}
          </span>
        );
      })}
    </nav>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const nav = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  const res = useApiQuery(['search', debounced], () => api.search(debounced), { enabled: debounced.trim().length >= 2 });
  const items: SearchResult[] = res.data ?? [];
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); box.current?.querySelector('input')?.focus(); }
    };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, []);
  const go = (r: SearchResult) => { setOpen(false); setQ(''); nav(r.href); };
  return (
    <div ref={box} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') { if (items[active]) go(items[active]); else if (q.trim().length >= 2) { setOpen(false); nav(`/search?q=${encodeURIComponent(q.trim())}`); } }
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Search issues, URLs, screens…"
        aria-label="Global search"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls="global-search-results"
        className="h-9 w-full rounded-ctl border border-transparent bg-[#F5F3F9] pl-8 pr-14 text-sm placeholder:text-faint transition-[border-color,background-color,box-shadow] hover:bg-[#F1ECFA] focus:border-signal focus:bg-surface focus:shadow-[0_0_0_3px_rgba(118,80,216,0.14)] focus:outline-none"
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-md border border-line bg-surface px-1.5 py-px font-sans text-[10.5px] text-faint sm:block">Ctrl K</kbd>
      {open && debounced.trim().length >= 2 && (
        <div id="global-search-results" role="listbox" className="anim-pop absolute z-40 mt-1.5 max-h-96 w-full overflow-y-auto rounded-panel border border-line bg-surface py-1 shadow-pop">
          {res.isLoading && <div className="px-3 py-2 text-sm text-muted">Searching…</div>}
          {!res.isLoading && !items.length && <div className="px-3 py-2 text-sm text-muted">No matches for “{debounced}”.</div>}
          {items.slice(0, 12).map((r, i) => (
            <button key={`${r.kind}-${r.id}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(r)} className={clsx('flex w-full items-center gap-2 px-3 py-1.5 text-left', i === active && 'bg-raised text-signal-dark')}>
              <span className="w-14 shrink-0 text-2xs capitalize text-faint">{r.kind}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{r.title}</span>
                {r.subtitle && <span className="block truncate text-xs text-muted">{r.subtitle}</span>}
              </span>
            </button>
          ))}
          {items.length > 12 && <button className="w-full px-3 py-1.5 text-left text-sm text-signal hover:underline" onClick={() => { setOpen(false); nav(`/search?q=${encodeURIComponent(debounced)}`); }}>See all {items.length} results</button>}
        </div>
      )}
    </div>
  );
}

function NotificationBell() {
  const q = useApiQuery(['notifications'], () => api.listNotifications(), { refetchInterval: 60000 });
  const unread = (q.data ?? []).filter((n) => !n.readAt).length;
  return (
    <Link to="/notifications" className="relative inline-flex h-9 w-9 items-center justify-center rounded-ctl text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} title="Notifications">
      <Bell className="h-[18px] w-[18px]" />
      {unread > 0 && <span className="absolute right-1 top-1 min-w-[16px] rounded-full bg-crit px-1 text-center text-[10px] font-semibold leading-4 text-canvas ring-2 ring-canvas">{unread > 99 ? '99+' : unread}</span>}
    </Link>
  );
}

export function AppShell() {
  const user = useUser();
  const { logout, previewAs, can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorageGet('sentinel.nav.collapsed') === '1');
  const [mobileOpen, setMobileOpen] = useState(false);
  const sections = useMemo(() => visibleNav(user.role, can), [user.role, can]);
  const websiteId = useWebsiteId();
  // Which collapsible groups are open — remembered for this browser session.
  const [groups, setGroups] = useState<Record<string, boolean>>(() => { try { return JSON.parse(sessionStorage.getItem('sentinel.nav.groups') ?? '{}'); } catch { return {}; } });
  useEffect(() => { try { sessionStorage.setItem('sentinel.nav.groups', JSON.stringify(groups)); } catch { /* storage unavailable */ } }, [groups]);
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  useEffect(() => { localStorageSet('sentinel.nav.collapsed', collapsed ? '1' : '0'); }, [collapsed]);
  const initials = user.name.split(' ').map((p) => p[0]).slice(0, 2).join('');

  const sidebar = (mobile: boolean) => {
    const icons = collapsed && !mobile;
    return (
      <div className="flex h-full flex-col border-r border-line bg-ink-side">
        <div className={clsx('flex h-14 shrink-0 items-center gap-2.5', icons ? 'justify-center px-2' : 'px-4')}>
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="8" fill="#7650D8" /><circle cx="16" cy="16" r="8.5" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeDasharray="38 16" strokeLinecap="round" /><circle cx="16" cy="16" r="2.8" fill="#FFFFFF" /></svg>
          {!icons && (
            <div className="min-w-0 leading-tight">
              <div className="text-[14px] font-semibold tracking-[-0.015em] text-ink">SEO Sentinel</div>
              <div className="truncate text-[11px] text-faint">DeoDap</div>
            </div>
          )}
          {mobile && <button className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-ctl text-muted hover:bg-raised hover:text-ink" aria-label="Close navigation" title="Close navigation" onClick={() => setMobileOpen(false)}><X className="h-[18px] w-[18px]" /></button>}
        </div>
        <nav className="sidebar-scroll flex-1 overflow-y-auto px-2.5 pb-3" aria-label="Primary">
          {sections.map((s, si) => {
            const hasActive = s.items.some((it) => isActive(it, loc.pathname));
            const open = !s.collapsible || icons || hasActive || !!groups[s.id];
            const listId = `nav-${s.id}${mobile ? '-m' : ''}`;
            return (
              <div key={s.id} className={clsx(si > 0 && 'mt-1.5 border-t border-line/70 pt-1.5')}>
                {!icons && (s.collapsible ? (
                  <button
                    type="button"
                    onClick={() => setGroups((g) => ({ ...g, [s.id]: !open }))}
                    disabled={hasActive}
                    aria-expanded={open}
                    aria-controls={listId}
                    className="group flex w-full items-center justify-between rounded-md px-2.5 py-1 text-[11.5px] font-medium text-faint transition-colors hover:text-ink disabled:cursor-default disabled:hover:text-faint"
                  >
                    {s.label}
                    <span className="flex items-center gap-1.5">
                      {!open && <span className="rounded-full bg-[#F5F3F9] px-1.5 text-[10px] font-medium text-muted">{s.items.length}</span>}
                      <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform duration-150', !open && '-rotate-90')} aria-hidden />
                    </span>
                  </button>
                ) : <div className="px-2.5 py-1 text-[11.5px] font-medium text-faint">{s.label}</div>)}
                <div className="nav-group" data-open={open}>
                  <ul id={listId} className="min-h-0 space-y-px overflow-hidden" aria-label={s.label}>
                    {s.items.map((it) => (
                      <li key={it.to}>
                        <NavLink
                          to={it.to}
                          end={it.end}
                          title={icons ? it.label : undefined}
                          className={({ isActive: on }) => clsx(
                            'group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-150',
                            icons && 'justify-center px-0',
                            on ? 'bg-signal-tint font-medium text-signal-dark' : 'text-ink-soft hover:bg-raised hover:text-ink',
                          )}
                        >
                          {({ isActive: on }) => (
                            <>
                              <it.icon className={clsx('h-4 w-4 shrink-0', on ? 'text-signal' : 'text-faint group-hover:text-signal')} strokeWidth={1.9} aria-hidden />
                              {!icons && <span className="truncate">{it.label}</span>}
                            </>
                          )}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </nav>
        {!mobile && (
          <div className="shrink-0 border-t border-line p-2">
            <button onClick={() => setCollapsed((c) => !c)} className={clsx('flex h-8 w-full items-center gap-2 rounded-lg text-[13px] text-muted transition-colors hover:bg-raised hover:text-signal', icons ? 'justify-center' : 'px-2.5')} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
              {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse sidebar</>}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <WebsiteProvider>
    <div className="flex h-screen overflow-hidden bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-ctl focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <aside className={clsx('hidden shrink-0 transition-[width] duration-300 ease-[cubic-bezier(.2,.7,.2,1)] lg:block', collapsed ? 'w-[64px]' : 'w-[236px]')}>{sidebar(false)}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="anim-slide-in w-[280px]">{sidebar(true)}</div>
          <div className="flex-1 bg-[#252238]/30 backdrop-blur-[2px]" onClick={() => setMobileOpen(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {(API_MODE === 'mock' || user.demo || user.serverDemoData) && (
          <div className="demo-hatch flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 border-b border-demo/25 px-3 py-1 text-center text-xs text-[#8A5408]">
            {API_MODE === 'mock' && <span><strong>DEMO mode</strong> — sample data in browser memory; changes reset on reload. No database.</span>}
            {API_MODE === 'http' && user.serverDemoData && <span><strong>DEMO data</strong> — the API server loaded sample data into temporary in-memory storage; it resets on restart. No database.</span>}
            {user.demo && <span><strong>DEVELOPMENT role preview</strong> as {ROLE_LABELS[user.role]} ({user.name}) — not production authentication.</span>}
          </div>
        )}
        <header className="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur sm:gap-3 sm:px-5">
          <button className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-ctl text-muted hover:bg-raised lg:hidden" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><MenuIcon className="h-5 w-5" /></button>
          <WebsiteSelector />
          <div className="hidden min-w-0 flex-1 items-center gap-3 xl:flex"><span className="h-5 w-px bg-line" aria-hidden /><Breadcrumbs /></div>
          <div className="flex min-w-0 flex-1 justify-end xl:flex-none xl:basis-[380px]"><GlobalSearch /></div>
          <NotificationBell />
          <Menu
            trigger={(toggle) => (
              <button onClick={toggle} className="flex items-center gap-2 rounded-ctl py-1 pl-1 pr-2 transition-colors hover:bg-raised" aria-label="Account menu" title="Account">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal-tint text-xs font-semibold text-signal-dark">{initials}</span>
                <span className="hidden min-w-0 text-left leading-tight xl:block">
                  <span className="block truncate text-[13px] font-medium text-ink">{user.name}</span>
                  <span className="block truncate text-[11px] text-muted">{ROLE_LABELS[user.role]}</span>
                </span>
                <ChevronDown className="hidden h-3.5 w-3.5 text-faint xl:block" aria-hidden />
              </button>
            )}
            items={[
              { label: <span className="flex items-center gap-2"><User className="h-4 w-4" /> Profile & settings</span>, onClick: () => nav('/profile') },
              ...(API_MODE === 'mock' ? (['admin', 'seo_specialist', 'developer'] as Role[]).filter((r) => r !== user.role).map((r) => ({
                label: <span className="flex items-center gap-2"><Eye className="h-4 w-4" /> Preview as {ROLE_LABELS[r]} <span className="text-2xs text-demo">DEV</span></span>,
                onClick: () => { void previewAs(r).then(() => nav('/')); },
              })) : []),
              { label: <span className="flex items-center gap-2"><LogOut className="h-4 w-4" /> Sign out</span>, onClick: () => { void logout().then(() => nav('/login')); } },
            ]}
          />
        </header>
        <main id="main" className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1560px] px-3 py-5 sm:px-6">
            <div className="mb-4 xl:hidden"><Breadcrumbs /></div>
            {/* Keyed by website too: switching websites remounts the page so no form or local state carries over. */}
            <div key={`${websiteId}:${loc.pathname}`} className="anim-page"><Outlet /></div>
          </div>
        </main>
      </div>
    </div>
    </WebsiteProvider>
  );
}

export function RoleChip() {
  const u = useUser();
  return <RoleBadge role={u.role} />;
}

function localStorageGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}
