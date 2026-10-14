import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, Gauge, CircleAlert, Users, Globe, FolderCog, Radar, Wrench, Zap, FileText, Code2, Link2, MessageSquareQuote,
  Sparkles, ShieldCheck, Bot, Lightbulb, Search, Layers, CalendarRange, Swords, Megaphone, AtSign, Newspaper, CalendarDays, CalendarClock,
  History, Bell, Plug, SlidersHorizontal, Settings2, ScrollText, Activity, Terminal, ListChecks, KeyRound, ArrowLeftRight, BadgeCheck,
  Ban, Network, PencilRuler,
} from 'lucide-react';
import type { Permission, Role } from '@sentinel/shared';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: Permission;
  roles?: Role[]; // restrict visibility by role in addition to permission
  end?: boolean;
}
/** `collapsible` groups can be folded; the group holding the current page always opens. */
export interface NavSection { id: string; label: string; items: NavItem[]; collapsible?: boolean }

export const NAV: NavSection[] = [
  {
    id: 'overview', label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, perm: 'dashboard.view', end: true },
      { to: '/websites/overview', label: 'All websites', icon: Globe, perm: 'dashboard.view' },
      { to: '/websites', label: 'Manage websites', icon: FolderCog, perm: 'dashboard.view', end: true },
    ],
  },
  {
    id: 'operations', label: 'SEO operations',
    items: [
      { to: '/health', label: 'Health score', icon: Gauge, perm: 'dashboard.view' },
      { to: '/issues', label: 'Issues board', icon: CircleAlert, perm: 'issues.view', end: true },
      { to: '/verification', label: 'Verification', icon: BadgeCheck, perm: 'crawls.view' },
      { to: '/crawls', label: 'Crawl Center', icon: Radar, perm: 'crawls.view' },
    ],
  },
  {
    id: 'modules', label: 'Audit modules', collapsible: true,
    items: [
      { to: '/modules/technical', label: 'Technical SEO', icon: Wrench, perm: 'modules.view' },
      { to: '/modules/performance', label: 'Performance & CWV', icon: Zap, perm: 'modules.view' },
      { to: '/modules/content', label: 'Content', icon: FileText, perm: 'modules.view', roles: ['admin', 'seo_specialist'] },
      { to: '/modules/onpage', label: 'On-page', icon: Code2, perm: 'modules.view' },
      { to: '/modules/offpage', label: 'Off-page', icon: Link2, perm: 'modules.view', roles: ['admin', 'seo_specialist'] },
      { to: '/modules/aeo', label: 'AEO', icon: MessageSquareQuote, perm: 'modules.view', roles: ['admin', 'seo_specialist'] },
      { to: '/modules/geo', label: 'GEO', icon: Sparkles, perm: 'modules.view', roles: ['admin', 'seo_specialist'] },
      { to: '/modules/ai-compliance', label: 'AI content compliance', icon: ShieldCheck, perm: 'modules.view', roles: ['admin', 'seo_specialist'] },
      { to: '/modules/ai-visibility', label: 'AI visibility', icon: Bot, perm: 'modules.view', roles: ['admin', 'seo_specialist'] },
    ],
  },
  {
    id: 'opportunities', label: 'Opportunities', collapsible: true,
    items: [
      { to: '/opportunities', label: 'Opportunity board', icon: Lightbulb, perm: 'opportunities.view', end: true },
      { to: '/opportunities/keywords', label: 'Keyword research', icon: Search, perm: 'opportunities.view' },
      { to: '/opportunities/gaps', label: 'Keyword gaps', icon: Layers, perm: 'opportunities.view' },
      { to: '/opportunities/briefs', label: 'Content briefs', icon: PencilRuler, perm: 'opportunities.view' },
      { to: '/opportunities/clusters', label: 'Topic clusters', icon: Network, perm: 'opportunities.view' },
      { to: '/opportunities/seasonal', label: 'Seasonal planner', icon: CalendarRange, perm: 'opportunities.view' },
      { to: '/competitors', label: 'Competitors', icon: Swords, perm: 'opportunities.view' },
      { to: '/opportunities/link-building', label: 'Digital PR & links', icon: Megaphone, perm: 'opportunities.view' },
      { to: '/opportunities/mentions', label: 'Brand mentions', icon: AtSign, perm: 'opportunities.view' },
    ],
  },
  {
    id: 'reporting', label: 'Reporting', collapsible: true,
    items: [
      { to: '/reports/daily', label: 'Daily digest', icon: Newspaper, perm: 'reports.view' },
      { to: '/reports/weekly', label: 'Weekly rollup', icon: CalendarDays, perm: 'reports.view' },
      { to: '/reports/monthly', label: 'Monthly executive', icon: CalendarClock, perm: 'reports.view' },
      { to: '/reports/history', label: 'Report history', icon: History, perm: 'reports.view' },
    ],
  },
  {
    id: 'team', label: 'Team', collapsible: true,
    items: [
      { to: '/team/employees', label: 'Employees', icon: Users, perm: 'employees.view' },
      { to: '/team/roles', label: 'Roles & permissions', icon: KeyRound, perm: 'roles.manage' },
      { to: '/team/allocations', label: 'Allocation history', icon: ArrowLeftRight, perm: 'issues.view', roles: ['admin', 'seo_specialist'] },
    ],
  },
  {
    id: 'configuration', label: 'Configuration', collapsible: true,
    items: [
      { to: '/settings/integrations', label: 'Integrations', icon: Plug, perm: 'integrations.view' },
      { to: '/settings/thresholds', label: 'Thresholds & scoring', icon: SlidersHorizontal, perm: 'settings.view' },
      { to: '/settings/crawl', label: 'Crawl configuration', icon: Settings2, perm: 'settings.view' },
      { to: '/settings/notifications', label: 'Alerts & notifications', icon: Bell, perm: 'notifications.configure' },
      { to: '/ai-compliance/rules', label: 'Custom AI rules', icon: ListChecks, perm: 'rules.view' },
      { to: '/issues/exclusions', label: 'Exclusions', icon: Ban, perm: 'issues.view', roles: ['admin', 'seo_specialist'] },
      { to: '/audit', label: 'Audit log', icon: ScrollText, perm: 'audit.view' },
      { to: '/system', label: 'System health', icon: Activity, perm: 'system.view' },
      { to: '/diagnostics', label: 'API diagnostics', icon: Terminal, perm: 'diagnostics.view' },
    ],
  },
];

export function visibleNav(role: Role, can: (p: Permission) => boolean): NavSection[] {
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => (!i.perm || can(i.perm)) && (!i.roles || i.roles.includes(role))) })).filter((s) => s.items.length);
}

/** True when `pathname` is the page an item points to (same rule NavLink uses). */
export function isActive(it: NavItem, pathname: string): boolean {
  if (it.to === '/') return pathname === '/';
  return it.end ? pathname === it.to : pathname === it.to || pathname.startsWith(`${it.to}/`);
}
