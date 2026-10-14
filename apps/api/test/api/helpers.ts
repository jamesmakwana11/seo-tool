import supertest from 'supertest';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';

export const DEMO = {
  admin: 'aarav.admin@demo.deodap.local',
  seoLead: 'ritesh.seo@demo.deodap.local',
  developer: 'ankit.dev@demo.deodap.local',
  password: 'Sentinel@Demo1',
};

/** A fetch stub that fails every outbound call — proves the server never claims success without a provider. */
export const failingFetch = async () => { throw new Error('network disabled in tests'); };

export async function makeHarness(envOverrides: Record<string, string> = {}) {
  const env = loadEnv({
    NODE_ENV: 'test', SEED_DEMO_DATA: 'true', SESSION_SECRET: 'test-secret-value-at-least-32-chars-long!!', LOG_LEVEL: 'silent',
    ALLOW_DEV_ROLE_PREVIEW: 'true', DEV_EXPOSE_RESET_TOKEN: 'true', ...envOverrides,
  });
  const container: Container = await createContainer({ env, fetchImpl: failingFetch });
  const app = createApp(container);
  const agent = supertest(app);

  async function token(email: string, password = DEMO.password): Promise<string> {
    const res = await agent.post('/api/auth/login').send({ email, password });
    if (res.status !== 200) throw new Error(`login failed (${res.status}): ${JSON.stringify(res.body)}`);
    return res.body.token as string;
  }

  function as(tok: string) {
    const auth = { Authorization: `Bearer ${tok}` };
    return {
      get: (p: string) => agent.get(p).set(auth),
      post: (p: string, body?: unknown) => agent.post(p).set(auth).send(body ?? {}),
      patch: (p: string, body?: unknown) => agent.patch(p).set(auth).send(body ?? {}),
      put: (p: string, body?: unknown) => agent.put(p).set(auth).send(body ?? {}),
      del: (p: string) => agent.delete(p).set(auth),
    };
  }

  return { container, app, agent, token, as };
}
