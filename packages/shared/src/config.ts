import type { AlertRule, PermissionMatrix, Role, SentinelConfig, Team, TeamId, ScoreModule, Permission } from './types';

/** Assignment teams — PDF §11.1a labels. */
export const TEAMS: Record<TeamId, Team> = {
  seo: { id: 'seo', name: '1into2 SEO Team', shortName: 'SEO', description: 'Strategy, schema decisions, redirects, links, keyword work.' },
  content: { id: 'content', name: '1into2 Content Team', shortName: 'Content', description: 'Copy, metadata, FAQs, content briefs.' },
  development: { id: 'development', name: '1into2 Development Team', shortName: 'Development', description: 'Theme, Liquid, apps, server issues.' },
};
export const TEAM_IDS: TeamId[] = ['seo', 'content', 'development'];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  seo_specialist: 'SEO Specialist',
  developer: 'Developer',
};

export const SCORE_MODULE_LABELS: Record<ScoreModule, string> = {
  technical: 'Technical SEO',
  onpage: 'On-Page SEO',
  content_ai: 'Content & AI Compliance',
  performance: 'Performance / CWV',
  offpage: 'Off-Page SEO',
  aeo: 'AEO',
  geo: 'GEO',
};

export const ALL_PERMISSIONS: Permission[] = [
  'dashboard.view', 'issues.view', 'issues.allocate', 'issues.update_status', 'issues.verify', 'issues.mark_not_issue', 'issues.manage_exclusions',
  'websites.manage', 'fixcards.approve_proposal', 'tasks.view_all', 'tasks.view_team', 'tasks.create', 'tasks.assign',
  'tasks.update_own', 'tasks.review', 'tasks.cancel', 'tasks.verify_trigger', 'crawls.view', 'crawls.run',
  'crawls.configure', 'modules.view', 'opportunities.view', 'opportunities.manage', 'reports.view',
  'reports.export', 'rules.view', 'rules.manage', 'qa_gate.approve', 'disavow.approve', 'employees.view',
  'employees.manage', 'roles.manage', 'integrations.view', 'integrations.manage', 'settings.view',
  'settings.manage', 'notifications.configure', 'audit.view', 'system.view', 'diagnostics.view', 'shopify.edit', 'shopify.theme',
];

/**
 * Default role → permission matrix (prompt §4.3). Admin can edit it at runtime
 * (Roles & Permissions screen); the backend enforces whatever is current.
 */
export const DEFAULT_PERMISSIONS: PermissionMatrix = {
  admin: [...ALL_PERMISSIONS],
  seo_specialist: [
    'dashboard.view', 'issues.view', 'issues.allocate', 'issues.update_status', 'issues.verify', 'issues.mark_not_issue', 'issues.manage_exclusions', 'websites.manage',
    'fixcards.approve_proposal', 'tasks.view_all', 'tasks.view_team', 'tasks.create', 'tasks.assign',
    'tasks.update_own', 'tasks.review', 'tasks.cancel', 'tasks.verify_trigger', 'crawls.view', 'crawls.run',
    'modules.view', 'opportunities.view', 'opportunities.manage', 'reports.view', 'reports.export',
    'rules.view', 'rules.manage', 'qa_gate.approve', 'disavow.approve', 'employees.view', 'settings.view',
    'settings.manage', 'notifications.configure', 'integrations.view', 'audit.view', 'shopify.edit',
  ],
  developer: [
    'dashboard.view', 'issues.view', 'issues.update_status', 'tasks.view_team', 'tasks.update_own', 'crawls.view', 'modules.view',
    'reports.view', 'employees.view', 'diagnostics.view', 'system.view', 'shopify.theme',
  ],
};

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  { type: 'sitewide_5xx', label: 'Sitewide 5xx', enabled: true, channels: ['in_app', 'slack', 'whatsapp'], recipients: ['development', 'seo'] },
  { type: 'robots_change', label: 'robots.txt change', enabled: true, channels: ['in_app', 'slack', 'whatsapp'], recipients: ['development', 'seo'] },
  { type: 'tier1_noindex', label: 'Homepage / Tier-1 noindex', enabled: true, channels: ['in_app', 'slack', 'whatsapp'], recipients: ['development', 'seo'] },
  { type: 'ssl_failure', label: 'SSL failure', enabled: true, channels: ['in_app', 'slack', 'whatsapp'], recipients: ['development', 'seo'] },
  { type: 'index_collapse', label: 'Indexed-page collapse', enabled: true, channels: ['in_app', 'slack', 'whatsapp'], recipients: ['development', 'seo'] },
  { type: 'toxic_link_spike', label: 'Toxic-link spike', enabled: true, channels: ['in_app', 'slack', 'whatsapp'], recipients: ['development', 'seo'] },
  { type: 'cwv_poor_template', label: 'Core Web Vitals template turning "Poor"', enabled: true, channels: ['in_app', 'slack', 'whatsapp'], recipients: ['development', 'seo'] },
];

/** Health score weights — PDF §14 exactly. */
export const HEALTH_WEIGHTS: Record<ScoreModule, number> = {
  technical: 0.3,
  onpage: 0.2,
  content_ai: 0.15,
  performance: 0.1,
  offpage: 0.1,
  aeo: 0.08,
  geo: 0.07,
};

/**
 * Default configuration. Values marked PDF are taken from seotooldocs.pdf.
 * Values marked WORKSHOP are not specified in the PDF ("Threshold values, competitor
 * lists, and the money-keyword set should be finalized in a kickoff workshop", p22)
 * and are editable by the SEO lead without code changes (PDF §17).
 */
export function defaultConfig(now = new Date()): SentinelConfig {
  return {
    site: { baseUrl: 'https://deodap.in', canonicalHost: 'deodap.in', brand: 'DeoDap', timezone: 'Asia/Kolkata' },
    tiers: { tier1TopCollections: 20, tier1TopProducts: 200, tier1Basis: 'revenue_or_sessions', tier1LookbackDays: 90 }, // PDF §3.1
    sla: { criticalSameDay: true, mediumDays: 7, lowDays: 30, watchWindowHours: 48 }, // PDF §3.2; watch window WORKSHOP
    escalation: { mediumBreachEscalates: true, tier1PromotionEscalates: true, templateGroupThreshold: 3, unallocatedCriticalHours: 24 }, // PDF §3.3, §11.1a, §12.4
    scoring: {
      weights: { ...HEALTH_WEIGHTS }, // PDF §14
      severityWeights: { critical: 10, medium: 3, low: 1 }, // WORKSHOP
      tierMultipliers: { 1: 5, 2: 1, 3: 1 }, // PDF §14: Tier 1 weighted 5×
      normalizationK: 0.1, // WORKSHOP — penalty points absorbed per indexable page
    },
    priority: { impactScale: [1, 5], minEffortHours: 0.5 }, // WORKSHOP scale for PDF §11 step 4
    thresholds: {
      indexDropPct24h: 2, // PDF 4.1
      sitemapMaxUrls: 50000, // PDF 4.1
      crawlDepthMax: 3, // PDF 4.1
      indexedDuplicatesCritical: 500, // PDF 4.1
      serverResponseMs: 3000, // PDF 4.2
      redirectMaxHops: 1, // PDF 4.2
      thinContentWords: 150, // PDF 4.3
      lcpMs: 2500, inpMs: 200, cls: 0.1, // PDF 4.4
      lcpPoorMs: 4000, inpPoorMs: 500, clsPoor: 0.25, // Google CWV "poor" boundaries
      psiRegressionPoints: 10, // PDF 4.4
      lcpDegradeCriticalMs: 500, // PDF 4.4
      imageMaxKb: 200, // PDF 4.4
      thirdPartyWeeklyGrowthPct: 15, // PDF 4.4
      certExpiryDays: 21, // PDF 4.5
      mobileViewportPx: 390, // PDF 4.5
      richResultDropPct: 5, // PDF 4.6
      contentQualityMin: 50, // PDF 5
      contentDecayPct: 20, contentDecayWindowDays: 28, // PDF 5
      freshnessDays: 180, // PDF 5
      titleMaxChars: 60, titleMinChars: 30, // PDF 6.1
      metaMaxChars: 160, metaMinChars: 70, // PDF 6.1
      homepageMaxInternalLinks: 500, // PDF 6.2
      collectionDescMinWords: 200, collectionDescMaxWords: 400, // PDF 6.2
      strikingMinPosition: 5, strikingMaxPosition: 20, strikingMinImpressions: 100, // PDF 6.3 (min impressions WORKSHOP)
      lowCtrMaxPosition: 5, // PDF 6.3
      lostLinkMinDr: 40, // PDF 7.1
      toxicDomainsPerWeekCritical: 50, // PDF 7.1
      exactMatchAnchorPct: 15, // PDF 7.1
      festivalLeadDays: 60, // PDF 7.2, 13
      answerBlockMinWords: 40, answerBlockMaxWords: 60, // PDF 8
      aiPromptPanelSize: 50, // PDF 8
      retrievalHeadingEveryMinWords: 150, retrievalHeadingEveryMaxWords: 300, // PDF 9
      scaledAbuseNearIdentical7d: 30, // PDF 10.1 #1
      dryRunWindowDays: 30, // PDF 10.2
      keywordGapMinCompetitors: 2, // PDF 13
      digestOpportunitiesStriking: 5, digestOpportunitiesCtr: 3, digestOpportunitiesBriefs: 1, // PDF 12.1
      weeklyTopPriorities: 10, // PDF 12.5
      falsePositiveTargetPct: 5, // PDF 16 acceptance
    },
    crawl: {
      smartTopProducts: 500, // PDF 2.1
      changedWithinHours: 48, // PDF 2.1
      fullCrawlCron: '0 2 * * 0', // weekly (Sunday 02:00 IST) — day/time WORKSHOP
      smartCrawlCron: '30 5 * * *', // daily 05:30 IST so the 08:00 digest is ready — WORKSHOP
      jsRenderSampleSize: 200, // WORKSHOP
      userAgent: 'DeoDapSEOSentinel/1.0 (+internal audit)',
      maxConcurrency: 4,
      requestTimeoutMs: 15000,
      respectRobots: true,
      renderViewportWidth: 390, // PDF 4.5
    },
    reporting: { dailyDigestTime: '08:00', weeklyDay: 'monday', monthlyDay: 1, channels: ['email', 'whatsapp', 'slack'] }, // PDF 12.1, 12.5
    automation: { autoRedirectDeletedProducts: false, autoApplySchemaUpdates: false }, // PDF §17 opt-ins, OFF by default
    alerts: DEFAULT_ALERT_RULES.map((a) => ({ ...a, channels: [...a.channels], recipients: [...a.recipients] })),
    competitors: [
      // WORKSHOP — placeholder names until the kickoff workshop finalises the list (PDF p22)
      { name: 'Competitor A', domain: 'competitor-a.example' },
      { name: 'Competitor B', domain: 'competitor-b.example' },
      { name: 'Competitor C', domain: 'competitor-c.example' },
    ],
    moneyKeywords: ['wholesale shopping india', 'dropshipping products india', 'wholesale kitchen products', 'no moq wholesale', 'wholesale toys india'],
    intentionalNoindex: ['/search', '/cart', '/account'],
    aiCrawlerPolicy: { GPTBot: 'allow', 'Google-Extended': 'allow', PerplexityBot: 'allow', CCBot: 'allow', Bingbot: 'allow' },
    festivals: [
      // Dates must be confirmed by the team (dateConfirmed=false) — lunar festivals shift yearly.
      { id: 'fest-diwali-2026', name: 'Diwali gifting', date: '2026-11-08', dateConfirmed: false, categories: ['home decor', 'gifts', 'lights', 'kitchen'], kind: 'festival' },
      { id: 'fest-wedding-2026', name: 'Wedding season', date: '2026-11-20', dateConfirmed: false, categories: ['gifts', 'home', 'kitchen'], kind: 'season' },
      { id: 'fest-christmas-2026', name: 'Christmas & New Year', date: '2026-12-25', dateConfirmed: true, categories: ['gifts', 'toys', 'decor'], kind: 'festival' },
      { id: 'fest-sankranti-2027', name: 'Makar Sankranti', date: '2027-01-14', dateConfirmed: false, categories: ['kites', 'outdoor'], kind: 'festival' },
      { id: 'fest-holi-2027', name: 'Holi', date: '2027-03-22', dateConfirmed: false, categories: ['colors', 'party supplies'], kind: 'festival' },
      { id: 'fest-school-2027', name: 'Back-to-school', date: '2027-04-01', dateConfirmed: false, categories: ['stationery', 'bags', 'bottles'], kind: 'season' },
      { id: 'fest-monsoon-2027', name: 'Monsoon products', date: '2027-06-15', dateConfirmed: false, categories: ['umbrellas', 'rainwear', 'home'], kind: 'season' },
      { id: 'fest-rakhi-2027', name: 'Raksha Bandhan (Rakhi)', date: '2027-08-17', dateConfirmed: false, categories: ['rakhi', 'gifts'], kind: 'festival' },
    ],
    updatedAt: now.toISOString(),
    updatedBy: 'system',
  };
}
