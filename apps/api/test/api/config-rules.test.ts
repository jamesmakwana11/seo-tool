import { describe, expect, it } from 'vitest';
import { DEMO, makeHarness } from './helpers';

describe('config validation', () => {
  it('rejects module weights that do not sum to 100%', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(DEMO.admin));
    const cfg = (await admin.get('/api/config')).body;
    const res = await admin.patch('/api/config', { scoring: { ...cfg.scoring, weights: { ...cfg.scoring.weights, technical: 0.9 } } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/weights must sum/i);
  });

  it('accepts a valid SLA change and records it in the audit log', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(DEMO.admin));
    const cfg = (await admin.get('/api/config')).body;
    const res = await admin.patch('/api/config', { sla: { ...cfg.sla, mediumDays: 5 } });
    expect(res.status).toBe(200);
    expect(res.body.sla.mediumDays).toBe(5);
    const audit = (await admin.get('/api/audit?q=configuration')).body.items;
    expect(audit.some((a: { action: string }) => a.action === 'config.update')).toBe(true);
  });
});

describe('custom rules — dry-run gate before enabling (PDF §10.2)', () => {
  const draft = {
    name: 'No lowest-price-in-India claims', description: 'Flag copy claiming the lowest price in India', method: 'phrase_list' as const,
    phrases: ['lowest price in india'], phraseMode: 'banned' as const, scope: { templates: [], collections: [], tiers: [], newlyPublishedOnly: false, fullSite: true },
    severity: 'medium' as const, defaultTeam: 'content' as const, action: 'flag' as const, schedule: 'daily' as const, enabled: false,
  };

  it('a rule cannot be created already enabled', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(DEMO.admin));
    const res = await admin.post('/api/rules', { ...draft, enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DRY_RUN_REQUIRED');
  });

  it('a rule cannot be enabled until a successful dry run has run', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(DEMO.admin));
    const created = await admin.post('/api/rules', draft);
    expect(created.status).toBe(200);
    const id = created.body.id;
    const early = await admin.patch(`/api/rules/${id}/enabled`, { enabled: true });
    expect(early.status).toBe(409);
    const dry = await admin.post('/api/rules/dry-run', { ...draft, id });
    expect(dry.status).toBe(200);
    expect(dry.body.evaluated).toBe(true);
    const ok = await admin.patch(`/api/rules/${id}/enabled`, { enabled: true });
    expect(ok.status).toBe(200);
    expect(ok.body.enabled).toBe(true);
  });

  it('an LLM-judged rule cannot be enabled without a provider', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(DEMO.admin));
    const llm = { ...draft, name: 'LLM delivery-promise check', method: 'llm_judged' as const, phrases: undefined, phraseMode: undefined, llmInstruction: 'Flag any description promising delivery timelines.' };
    const created = await admin.post('/api/rules', llm);
    expect(created.status).toBe(200);
    const dry = await admin.post('/api/rules/dry-run', { ...llm, id: created.body.id });
    expect(dry.body.evaluated).toBe(false); // no LLM provider configured → not evaluated, never a fake pass
    const res = await admin.patch(`/api/rules/${created.body.id}/enabled`, { enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROVIDER_REQUIRED');
  });

  it('rejects a ReDoS-prone regex pattern', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(DEMO.admin));
    const res = await admin.post('/api/rules', { ...draft, method: 'regex', pattern: '(a+)+$', phrases: undefined, phraseMode: undefined });
    expect(res.status).toBe(400);
  });
});
