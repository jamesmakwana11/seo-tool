import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, INTEGRATION_CATALOG, normalizeIntegrationProperty, type IntegrationId, type IntegrationStatus, type ShopifyStatus } from '@sentinel/shared';

/**
 * Integrations: three permanent cards (Site crawler, GSC, GA4), every other integration one at a time from a dropdown,
 * the GSC / GA4 property saved through the API; Shopify: clear setup errors and .myshopify.com validation. Mocked API.
 */
const fake = vi.hoisted(() => ({
  settings: {} as Record<string, Record<string, string | number | boolean>>,
  updates: [] as { id: string; settings: Record<string, unknown> }[],
  tests: [] as string[],
  shopify: undefined as unknown as ShopifyStatus,
  started: [] as string[],
}));

const status = (id: IntegrationId): IntegrationStatus => {
  const base = INTEGRATION_CATALOG.find((x) => x.id === id)!;
  const s = fake.settings[id] ?? {};
  const prop = id === 'gsc' ? { key: 'property', envVar: 'GSC_PROPERTY' } : id === 'ga4' ? { key: 'propertyId', envVar: 'GA4_PROPERTY_ID' } : undefined;
  return {
    ...base, state: 'not_configured', stateDetail: `${base.name} detail`, configuredVars: [], settings: s,
    ...(prop ? { property: { ...prop, value: s[prop.key] ? String(s[prop.key]) : undefined, source: s[prop.key] ? 'saved' as const : 'none' as const } } : {}),
  };
};

vi.mock('@/api/client', () => ({
  API_MODE: 'http',
  api: {
    listIntegrations: async () => INTEGRATION_CATALOG.map((i) => status(i.id)),
    updateIntegration: async (id: IntegrationId, settings: Record<string, string>) => {
      fake.updates.push({ id, settings });
      const key = id === 'gsc' ? 'property' : 'propertyId';
      if (key in settings && settings[key]) {
        const c = normalizeIntegrationProperty(id as 'gsc' | 'ga4', settings[key]);
        if (!c.ok) throw new ApiError(400, 'VALIDATION', c.error);
        settings = { ...settings, [key]: c.value };
      }
      fake.settings[id] = { ...(fake.settings[id] ?? {}), ...settings };
      return status(id);
    },
    testIntegration: async (id: IntegrationId) => { fake.tests.push(id); return status(id); },
    syncIntegration: async () => ({ ran: false, reason: 'x' }),
    getShopifyStatus: async () => fake.shopify,
    startShopifyOAuth: async (shop: string) => { fake.started.push(shop); throw new ApiError(409, 'SHOPIFY_OAUTH_NOT_CONFIGURED', 'not set up'); },
    disconnectShopify: async () => fake.shopify,
  },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));

import { ToastProvider } from '../src/components/ui/Toast';
import IntegrationsPage from '../src/pages/settings/IntegrationsPage';
import ShopifyPage from '../src/pages/settings/ShopifyPage';
import { appBasePath } from '../src/lib/basePath';

afterEach(cleanup);

function show(el: JSX.Element) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{el}</MemoryRouter></ToastProvider>
    </QueryClientProvider>,
  );
}
const cardTitles = (root: HTMLElement) => within(root).getAllByRole('heading').map((h) => h.textContent);

describe('Integrations screen', () => {
  it('always shows Site crawler, GSC and GA4; the others one at a time from the dropdown', async () => {
    show(<IntegrationsPage />);
    const primary = await screen.findByTestId('primary-integrations');
    expect(cardTitles(primary)).toEqual(['Site crawler', 'Google Search Console API', 'Google Analytics 4 API']);
    // No additional card until one is chosen.
    expect(screen.queryByTestId('selected-integration')).toBeNull();
    const picker = screen.getByTestId('integration-picker') as HTMLSelectElement;
    const options = [...picker.options].map((o) => o.value).filter(Boolean);
    expect(options).not.toContain('crawler');
    expect(options).not.toContain('gsc');
    expect(options).not.toContain('ga4');
    expect(options).toEqual(expect.arrayContaining(['psi_crux', 'shopify', 'openai', 'slack']));

    fireEvent.change(picker, { target: { value: 'shopify' } });
    let chosen = await screen.findByTestId('selected-integration');
    expect(cardTitles(chosen)).toEqual(['Shopify Admin API + webhooks']);
    // Changing the selection replaces the card instead of adding another.
    fireEvent.change(picker, { target: { value: 'openai' } });
    chosen = await screen.findByTestId('selected-integration');
    expect(cardTitles(chosen)).toEqual(['OpenAI API']);
    expect(screen.queryByText('Shopify Admin API + webhooks')).toBeNull();
    expect(cardTitles(screen.getByTestId('primary-integrations'))).toHaveLength(3);
    // Back to none.
    fireEvent.change(picker, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByTestId('selected-integration')).toBeNull());
  });

  it('saves the GSC property and the GA4 property ID (validated) through the API', async () => {
    fake.updates = [];
    fake.settings = {};
    show(<IntegrationsPage />);
    const gsc = await screen.findByTestId('property-gsc');
    expect(within(screen.getByTestId('property-source-gsc')).getByText(/No property yet/)).toBeTruthy();
    const input = within(gsc).getByLabelText('Search Console property');
    fireEvent.change(input, { target: { value: 'deodap.in' } });
    expect(within(gsc).getByRole('alert').textContent).toMatch(/sc-domain:deodap\.in/);
    expect((within(gsc).getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'sc-domain:deodap.in' } });
    fireEvent.click(within(gsc).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(fake.updates).toEqual([{ id: 'gsc', settings: { property: 'sc-domain:deodap.in' } }]));
    await waitFor(() => expect(screen.getByTestId('property-source-gsc').textContent).toMatch(/In use: sc-domain:deodap\.in \(saved for this website\)/));
    // The property alone is not presented as a connection.
    expect(screen.getByTestId('property-source-gsc').textContent).toMatch(/service-account key/);

    const ga4 = screen.getByTestId('property-ga4');
    const pid = within(ga4).getByLabelText('GA4 property ID');
    fireEvent.change(pid, { target: { value: 'G-ABC123' } });
    expect(within(ga4).getByRole('alert').textContent).toMatch(/Measurement ID/);
    fireEvent.change(pid, { target: { value: '123456789' } });
    fireEvent.click(within(ga4).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(fake.updates.at(-1)).toEqual({ id: 'ga4', settings: { propertyId: '123456789' } }));
  });

  it('marks CRAWLER_USER_AGENT as optional on the Site crawler card', async () => {
    fake.settings = {};
    show(<IntegrationsPage />);
    const primary = await screen.findByTestId('primary-integrations');
    const ua = within(primary).getByText('CRAWLER_USER_AGENT').closest('li')!;
    expect(ua.textContent).toMatch(/optional/);
  });
});

describe('Shopify connect', () => {
  const base: ShopifyStatus = {
    connected: false, via: null, apiVersion: '2026-07', scopes: [], missingScopes: [], missingOptionalScopes: [], requiredScopes: ['read_products', 'write_products', 'read_content', 'write_content'], optionalScopes: [],
    oauthConfigured: false, redirectUrl: 'https://apps.deodap.info/seo-tool/api/shopify/oauth/callback', problems: ['Connect with Shopify is not set up on the server: set SHOPIFY_API_KEY (the app’s Client ID) …'], tokenNote: 'memory',
    capabilities: { edit: false, themes: false, themeWrite: false, imageAlt: false },
  } as ShopifyStatus;

  it('explains what is missing next to a disabled button instead of doing nothing', async () => {
    fake.shopify = base;
    show(<ShopifyPage />);
    const note = await screen.findByTestId('shopify-not-configured');
    expect(note.textContent).toMatch(/not available yet/);
    expect(note.textContent).toMatch(/SHOPIFY_API_KEY/);
    expect((screen.getByRole('button', { name: 'Connect with Shopify' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('https://apps.deodap.info/seo-tool/api/shopify/oauth/callback')).toBeTruthy();
  });

  it('validates the .myshopify.com domain and shows a start error inline', async () => {
    fake.shopify = { ...base, oauthConfigured: true, problems: [] };
    fake.started = [];
    show(<ShopifyPage />);
    const input = await screen.findByLabelText('Store');
    fireEvent.change(input, { target: { value: 'deodap.in' } });
    expect(screen.getByRole('alert').textContent).toMatch(/\.myshopify\.com domain/);
    expect((screen.getByRole('button', { name: 'Connect with Shopify' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'deodap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect with Shopify' }));
    await waitFor(() => expect(fake.started).toEqual(['deodap.myshopify.com']));
    expect(await screen.findByText('Could not start the connection')).toBeTruthy();
  });
});

describe('base path', () => {
  it('reads the path the server set in index.html', () => {
    const doc = (content?: string) => ({ querySelector: () => (content === undefined ? null : { getAttribute: () => content }) }) as unknown as Document;
    expect(appBasePath(doc('/seo-tool'))).toBe('/seo-tool');
    expect(appBasePath(doc('/seo-tool/'))).toBe('/seo-tool');
    expect(appBasePath(doc(''))).toBe('');
    expect(appBasePath(doc())).toBe('');
    expect(appBasePath(doc('javascript:x'))).toBe('');
  });
});
