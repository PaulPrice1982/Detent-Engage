/**
 * Liveness and readiness, answered in every spelling a platform might ask for.
 *
 * Which path a platform probes is the platform's choice, not ours. Answering
 * only one of them and 404ing the rest is a container that a differently
 * configured platform decides is dead, and the symptom is a restart loop with
 * a perfectly healthy process inside it.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness } from './fixtures/tenant.js';

describe('liveness', () => {
  it.each(['/health', '/healthz', '/_health', '/livez'])('answers %s', async (path) => {
    const harness = await buildHarness();
    const response = await harness.api.handle({ method: 'GET', path, headers: {} });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('needs no authentication, because a probe carries none', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({ method: 'GET', path: '/health', headers: {} });
    expect(response.status).toBe(200);
  });

  it('discloses nothing but that it is alive', async () => {
    // The kill-switch state used to be readable here unauthenticated, which
    // told an attacker exactly when to push (SEC-10).
    const harness = await buildHarness();
    const response = await harness.api.handle({ method: 'GET', path: '/health', headers: {} });
    expect(Object.keys(response.body as object)).toEqual(['status']);
  });
});

describe('readiness', () => {
  it('is a different question from liveness, and answers it', async () => {
    // A process can be alive and not fit to be sent traffic. During a rollout
    // the two have different answers, which is the whole reason for two paths.
    const harness = await buildHarness();
    const response = await harness.api.handle({ method: 'GET', path: '/readyz', headers: {} });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready' });
  });

  it('reports durability as measured, not as claimed', async () => {
    // The fixture runs on in-memory stores, so this must say so. A readiness
    // endpoint that reports durability the deployment asserted about itself is
    // repeating the claim back rather than checking it.
    const harness = await buildHarness();
    const response = await harness.api.handle({ method: 'GET', path: '/readyz', headers: {} });
    expect((response.body as { durable: boolean }).durable).toBe(false);
  });
});
