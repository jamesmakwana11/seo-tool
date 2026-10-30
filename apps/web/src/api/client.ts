import type { SentinelApi } from '@sentinel/shared';
import { createHttpApi } from './http/httpApi';
import { websiteScope } from './websiteScope';
import { appBasePath } from '@/lib/basePath';

/** The API server (same origin, under the app's base path). VITE_API_BASE_URL overrides the default /api base. */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? `${appBasePath()}/api`;

export const api: SentinelApi = createHttpApi(API_BASE_URL, websiteScope.get);
