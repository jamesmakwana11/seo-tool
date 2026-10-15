import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import type { Permission } from '@sentinel/shared';
import { useAuth } from '@/auth/AuthContext';
import { AppShell } from '@/layout/AppShell';
import { EmptyState, LoadingBlock } from '@/components/ui/primitives';
import { RequireAuditData } from '@/components/websites/NoAuditData';

const L = (f: () => Promise<{ default: ComponentType }>) => lazy(f);

const P = {
  Login: L(() => import('@/pages/auth/LoginPage')),
  Forgot: L(() => import('@/pages/auth/ForgotPasswordPage')),
  Reset: L(() => import('@/pages/auth/ResetPasswordPage')),
  Dashboard: L(() => import('@/pages/DashboardPage')),
  Health: L(() => import('@/pages/health/HealthPage')),
  Search: L(() => import('@/pages/search/SearchPage')),
  Notifications: L(() => import('@/pages/notifications/NotificationsPage')),
  Profile: L(() => import('@/pages/profile/ProfilePage')),
  Technical: L(() => import('@/pages/modules/TechnicalPage')),
  TechnicalGroup: L(() => import('@/pages/modules/TechnicalGroupPage')),
  Performance: L(() => import('@/pages/modules/PerformancePage')),
  Content: L(() => import('@/pages/modules/ContentPage')),
  OnPage: L(() => import('@/pages/modules/OnPagePage')),
  OffPage: L(() => import('@/pages/modules/OffPagePage')),
  Backlinks: L(() => import('@/pages/modules/BacklinksPage')),
  Aeo: L(() => import('@/pages/modules/AeoPage')),
  Geo: L(() => import('@/pages/modules/GeoPage')),
  AiCompliance: L(() => import('@/pages/modules/AiCompliancePage')),
  AiVisibility: L(() => import('@/pages/modules/AiVisibilityPage')),
  Crawls: L(() => import('@/pages/crawls/CrawlCenterPage')),
  CrawlRun: L(() => import('@/pages/crawls/CrawlRunPage')),
  Verification: L(() => import('@/pages/crawls/VerificationPage')),
  Issues: L(() => import('@/pages/issues/IssuesBoardPage')),
  Issue: L(() => import('@/pages/issues/IssueDetailPage')),
  IssueGroups: L(() => import('@/pages/issues/IssueGroupsPage')),
  Exclusions: L(() => import('@/pages/issues/ExclusionsPage')),
  Websites: L(() => import('@/pages/websites/WebsitesPage')),
  WebsitesOverview: L(() => import('@/pages/websites/WebsitesOverviewPage')),
  Allocations: L(() => import('@/pages/team/AllocationHistoryPage')),
  Employees: L(() => import('@/pages/team/EmployeesPage')),
  Roles: L(() => import('@/pages/team/RolesPage')),
  Opps: L(() => import('@/pages/opportunities/OpportunitiesBoardPage')),
  Keywords: L(() => import('@/pages/opportunities/KeywordResearchPage')),
  Gaps: L(() => import('@/pages/opportunities/KeywordGapsPage')),
  Briefs: L(() => import('@/pages/opportunities/BriefsPage')),
  Brief: L(() => import('@/pages/opportunities/BriefEditorPage')),
  Clusters: L(() => import('@/pages/opportunities/ClustersPage')),
  Seasonal: L(() => import('@/pages/opportunities/SeasonalPage')),
  LinkBuilding: L(() => import('@/pages/opportunities/LinkBuildingPage')),
  Mentions: L(() => import('@/pages/opportunities/MentionsPage')),
  Competitors: L(() => import('@/pages/competitors/CompetitorsPage')),
  Daily: L(() => import('@/pages/reports/DailyDigestPage')),
  Weekly: L(() => import('@/pages/reports/WeeklyReportPage')),
  Monthly: L(() => import('@/pages/reports/MonthlyReportPage')),
  ReportHistory: L(() => import('@/pages/reports/ReportHistoryPage')),
  NotifSettings: L(() => import('@/pages/settings/NotificationSettingsPage')),
  Integrations: L(() => import('@/pages/settings/IntegrationsPage')),
  Shopify: L(() => import('@/pages/settings/ShopifyPage')),
  SeoEditor: L(() => import('@/pages/shopify/SeoEditorPage')),
  Thresholds: L(() => import('@/pages/settings/ThresholdsPage')),
  CrawlConfig: L(() => import('@/pages/settings/CrawlConfigPage')),
  Rules: L(() => import('@/pages/rules/RuleBuilderPage')),
  Audit: L(() => import('@/pages/admin/AuditLogPage')),
  System: L(() => import('@/pages/admin/SystemHealthPage')),
  Diagnostics: L(() => import('@/pages/admin/DiagnosticsPage')),
  NotFound: L(() => import('@/pages/NotFoundPage')),
};

/** Route guard (UI only — the backend enforces permissions independently). */
function Guard({ perm, children }: { perm?: Permission; children: ReactNode }) {
  const { can } = useAuth();
  if (perm && !can(perm)) {
    return <EmptyState icon={<ShieldAlert className="h-8 w-8 text-med-ink" />} title="You don't have access to this page" description={`Your role needs the "${perm}" permission. Ask an Admin if you need it.`} />;
  }
  return <Suspense fallback={<LoadingBlock rows={6} />}>{children}</Suspense>;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <div className="p-8"><LoadingBlock rows={3} label="Checking session" /></div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

const g = (C: ComponentType, perm?: Permission) => <Guard perm={perm}><C /></Guard>;
/** Scored / pass-fail screens: shown only for a website that has audit data (never a fake score for an uncrawled site). */
const ga = (C: ComponentType, perm?: Permission) => <Guard perm={perm}><RequireAuditData><C /></RequireAuditData></Guard>;

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Suspense fallback={null}><P.Login /></Suspense>} />
      <Route path="/forgot-password" element={<Suspense fallback={null}><P.Forgot /></Suspense>} />
      <Route path="/reset-password" element={<Suspense fallback={null}><P.Reset /></Suspense>} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={ga(P.Dashboard, 'dashboard.view')} />
        <Route path="health" element={ga(P.Health, 'dashboard.view')} />
        <Route path="search" element={g(P.Search)} />
        <Route path="notifications" element={g(P.Notifications)} />
        <Route path="profile" element={g(P.Profile)} />

        <Route path="modules/technical" element={ga(P.Technical, 'modules.view')} />
        <Route path="modules/technical/:group" element={ga(P.TechnicalGroup, 'modules.view')} />
        <Route path="modules/performance" element={ga(P.Performance, 'modules.view')} />
        <Route path="modules/content" element={ga(P.Content, 'modules.view')} />
        <Route path="modules/onpage" element={ga(P.OnPage, 'modules.view')} />
        <Route path="modules/offpage" element={ga(P.OffPage, 'modules.view')} />
        <Route path="modules/offpage/backlinks" element={ga(P.Backlinks, 'modules.view')} />
        <Route path="modules/aeo" element={ga(P.Aeo, 'modules.view')} />
        <Route path="modules/geo" element={ga(P.Geo, 'modules.view')} />
        <Route path="modules/ai-compliance" element={ga(P.AiCompliance, 'modules.view')} />
        <Route path="modules/ai-visibility" element={ga(P.AiVisibility, 'modules.view')} />

        <Route path="crawls" element={g(P.Crawls, 'crawls.view')} />
        <Route path="crawls/:id" element={g(P.CrawlRun, 'crawls.view')} />
        <Route path="verification" element={g(P.Verification, 'crawls.view')} />

        <Route path="issues" element={g(P.Issues, 'issues.view')} />
        <Route path="issues/groups" element={g(P.IssueGroups, 'issues.view')} />
        <Route path="issues/exclusions" element={g(P.Exclusions, 'issues.view')} />
        <Route path="issues/:id" element={g(P.Issue, 'issues.view')} />

        <Route path="websites" element={g(P.Websites, 'dashboard.view')} />
        <Route path="websites/overview" element={g(P.WebsitesOverview, 'dashboard.view')} />

        <Route path="team/employees" element={g(P.Employees, 'employees.view')} />
        <Route path="team/roles" element={g(P.Roles, 'roles.manage')} />
        <Route path="team/allocations" element={g(P.Allocations, 'issues.view')} />

        <Route path="opportunities" element={g(P.Opps, 'opportunities.view')} />
        <Route path="opportunities/keywords" element={g(P.Keywords, 'opportunities.view')} />
        <Route path="opportunities/gaps" element={g(P.Gaps, 'opportunities.view')} />
        <Route path="opportunities/briefs" element={g(P.Briefs, 'opportunities.view')} />
        <Route path="opportunities/briefs/:id" element={g(P.Brief, 'opportunities.view')} />
        <Route path="opportunities/clusters" element={g(P.Clusters, 'opportunities.view')} />
        <Route path="opportunities/seasonal" element={g(P.Seasonal, 'opportunities.view')} />
        <Route path="opportunities/link-building" element={g(P.LinkBuilding, 'opportunities.view')} />
        <Route path="opportunities/mentions" element={g(P.Mentions, 'opportunities.view')} />
        <Route path="competitors" element={g(P.Competitors, 'opportunities.view')} />

        <Route path="reports/daily" element={ga(P.Daily, 'reports.view')} />
        <Route path="reports/weekly" element={ga(P.Weekly, 'reports.view')} />
        <Route path="reports/monthly" element={ga(P.Monthly, 'reports.view')} />
        <Route path="reports/history" element={g(P.ReportHistory, 'reports.view')} />

        <Route path="ai-compliance/rules" element={g(P.Rules, 'rules.view')} />
        <Route path="settings/notifications" element={g(P.NotifSettings, 'notifications.configure')} />
        <Route path="settings/integrations" element={g(P.Integrations, 'integrations.view')} />
        <Route path="settings/shopify" element={g(P.Shopify, 'integrations.view')} />
        <Route path="seo-editor" element={g(P.SeoEditor)} />
        <Route path="settings/thresholds" element={g(P.Thresholds, 'settings.view')} />
        <Route path="settings/crawl" element={g(P.CrawlConfig, 'settings.view')} />
        <Route path="audit" element={g(P.Audit, 'audit.view')} />
        <Route path="system" element={g(P.System, 'system.view')} />
        <Route path="diagnostics" element={g(P.Diagnostics, 'diagnostics.view')} />
        <Route path="*" element={g(P.NotFound)} />
      </Route>
    </Routes>
  );
}

/** Every routed path, used by the e2e smoke test. */
export const SMOKE_PATHS = [
  '/', '/health', '/search?q=schema', '/notifications', '/profile', '/modules/technical', '/modules/technical/crawlability', '/modules/technical/responses',
  '/modules/technical/canonicals', '/modules/technical/security', '/modules/technical/structured-data', '/modules/performance', '/modules/content', '/modules/onpage',
  '/modules/offpage', '/modules/offpage/backlinks', '/modules/aeo', '/modules/geo', '/modules/ai-compliance', '/modules/ai-visibility', '/crawls', '/verification',
  '/issues', '/issues/groups', '/issues/exclusions', '/websites', '/websites/overview', '/team/employees', '/team/roles',
  '/team/allocations', '/opportunities', '/opportunities/keywords', '/opportunities/gaps', '/opportunities/briefs', '/opportunities/clusters', '/opportunities/seasonal',
  '/opportunities/link-building', '/opportunities/mentions', '/competitors', '/reports/daily', '/reports/weekly', '/reports/monthly', '/reports/history',
  '/ai-compliance/rules', '/settings/notifications', '/settings/integrations', '/settings/shopify', '/seo-editor', '/settings/thresholds', '/settings/crawl', '/audit', '/system', '/diagnostics',
];
