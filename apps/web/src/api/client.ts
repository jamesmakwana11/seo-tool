import type { SentinelApi } from '@sentinel/shared';
import { createMockApi } from './mock/mockApi';
import { createHttpApi } from './http/httpApi';
import { websiteScope } from './websiteScope';

/**
 * API mode:
 *  - "mock": in-browser DEMO adapter (Phase 1). State is in memory only.
 *  - "http": the apps/api backend (Phase 2). Vite proxies /api → http://localhost:4000.
 * Selected at build time with VITE_API_MODE; VITE_API_BASE_URL overrides the default /api base.
 */
export const API_MODE: 'mock' | 'http' = (import.meta.env.VITE_API_MODE as 'mock' | 'http' | undefined) ?? 'mock';
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';

export const api: SentinelApi = API_MODE === 'http' ? createHttpApi(API_BASE_URL, websiteScope.get) : createMockApi({ websiteId: websiteScope.get });
