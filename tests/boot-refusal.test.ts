/**
 * A start-up fault must be readable, not a restart.
 *
 * The deployment crash looped twice. Both times the code that explains the
 * problem existed and was correct, and both times something above it threw
 * first: the process died before it could serve the explanation, and the host
 * reported only "built successfully but failed to start".
 *
 * This is the gate for that. It starts the real server against a database that
 * is set and unreachable, which is the commonest deployment fault there is,
 * and requires it to stay up and say so. It boots a process rather than
 * calling a function on purpose: the fault being caught is an ordering fault
 * in the boot sequence, and no unit test can see the order things run in.
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

/** A port nothing else holds, taken and released so the server can bind it. */
async function freePort(): Promise<number> {
  return await new Promise((settle, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => settle(port));
    });
  });
}

/** Polls until the server answers or the deadline passes. */
async function waitForAnswer(port: number, path: string, msTotal: number): Promise<Response> {
  const deadline = Date.now() + msTotal;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}${path}`);
    } catch (error) {
      last = error;
      await new Promise((wake) => setTimeout(wake, 250));
    }
  }
  throw new Error(`Nothing answered on ${port}${path} within ${msTotal}ms: ${String(last)}`);
}

describe('a start-up fault is served, not crashed', () => {
  it('answers 503 and names the database when DATABASE_URL is unreachable', async () => {
    const port = await freePort();
    const server = spawn(process.execPath, ['tools/serve.mjs'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        // Set, syntactically valid, and nothing is listening there.
        DATABASE_URL: 'postgres://detent:detent@127.0.0.1:1/detent',
        // A deployment, so a database fault is a refusal rather than a warning.
        DETENT_DEPLOYED: 'true',
        REPLIT_DEPLOYMENT: '',
        NODE_ENV: '',
      },
    });
    let output = '';
    server.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    server.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    let exited = false;
    server.on('exit', () => { exited = true; });

    try {
      // 200 on the probe path, deliberately. The platform routes traffic to
      // this container only while its probe answers 200, and a page nobody can
      // reach explains nothing. The header and the body both say what this is.
      const health = await waitForAnswer(port, '/health', 60_000);
      expect(health.status).toBe(200);
      expect(health.headers.get('x-detent-status')).toBe('not_configured');
      const body = await health.json() as { status: string; reasons: string[] };
      expect(body.status).toBe('not_configured');
      expect(body.reasons.join(' ')).toMatch(/database/i);

      // And a browser opening the deployment reads the reason, as a page.
      const page = await waitForAnswer(port, '/', 10_000);
      expect(page.status).toBe(200);
      expect(page.headers.get('x-detent-status')).toBe('not_configured');
      expect(page.headers.get('x-robots-tag')).toMatch(/noindex/);
      expect(await page.text()).toMatch(/database/i);

      // Every other path is honestly unavailable.
      const inside = await waitForAnswer(port, '/console/sign-in', 10_000);
      expect(inside.status).toBe(503);
      expect(await inside.text()).toMatch(/database/i);

      // Still running. A process that answers once and then exits is still a
      // crash loop, just a slower one.
      expect(exited, `the server exited during the test. Output:\n${output}`).toBe(false);
    } finally {
      server.kill('SIGKILL');
    }
  });
});
