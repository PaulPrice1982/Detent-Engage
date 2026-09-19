/**
 * The websites are actually mounted on the server that runs.
 *
 * The fault this exists for was total and silent. `buildDevSites` built the
 * marketing site, the customer area, the reseller portal and the staff
 * console; `resolveSite` decided which hostname served which; `createHttpServer`
 * accepted a list of mounted sites. The entry point passed none of them, so in
 * every deployment every sign-in page, the console and the customer area
 * answered 404, and the only reachable surface was the JSON API.
 *
 * Nothing caught it because nothing asked. Every test of the sites called
 * `buildDevSites` directly and passed, which proves the sites work and says
 * nothing about whether anyone can reach them. So this boots the real entry
 * point and asks it over a socket, which is the only way the question can be
 * put.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

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

let server: ChildProcess;
let port: number;
let output = '';

beforeAll(async () => {
  port = await freePort();
  server = spawn(process.execPath, ['tools/serve.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      // A development boot: no database, so every store is in memory and the
      // question is only whether the sites are reachable.
      DATABASE_URL: '',
      DETENT_DEPLOYED: '',
      REPLIT_DEPLOYMENT: '',
      NODE_ENV: '',
      DETENT_CONSOLE_EMAIL: 'operator@example.test',
      DETENT_CONSOLE_PASSWORD: 'correct horse battery staple',
      DETENT_SESSION_SECRET: 'a-stable-session-secret-of-at-least-32-chars',
    },
  });
  server.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  server.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/console/signin`);
      return;
    } catch {
      await new Promise((wake) => setTimeout(wake, 250));
    }
  }
  throw new Error(`the server never answered. Output:\n${output}`);
}, 90_000);

afterAll(() => { server?.kill('SIGKILL'); });

describe('the sites a person signs in through', () => {
  it.each([
    ['/console/signin', /sign in/i],
    ['/app/signin', /sign in/i],
    ['/reseller/signin', /sign in/i],
    ['/app/signup', /.+/],
    ['/console/forgot', /.+/],
  ])('serves %s', async (path, expected) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    expect(response.status, `${path} was not served. Output:\n${output}`).toBe(200);
    expect(await response.text()).toMatch(expected);
  });

  it('serves the marketing home', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
  });

  it('still routes the API, which the sites must not shadow', async () => {
    // A site mounted at '' matches every path including /v1/*. If it ever
    // answers one, every conversation the widget starts stops working.
    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jurisdiction: 'UK' }),
    });
    // Refused for want of a key, not 404 for want of a route. The distinction
    // is the whole assertion.
    expect(response.status).not.toBe(404);
    expect([401, 403]).toContain(response.status);
  });

  it('lets the seeded operator sign in and reach the console', async () => {
    const form = new URLSearchParams({
      email: 'operator@example.test',
      password: 'correct horse battery staple',
    });
    const signIn = await fetch(`http://127.0.0.1:${port}/console/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(signIn.status, `sign-in failed. Output:\n${output}`).toBe(303);

    const cookie = (signIn.headers.getSetCookie?.() ?? [])
      .map((one) => one.split(';')[0]).join('; ');
    expect(cookie, 'no session cookie was set').toMatch(/detent_console=/);

    const console_ = await fetch(`http://127.0.0.1:${port}/console`, { headers: { cookie } });
    expect(console_.status).toBe(200);
  });

  it('refuses the wrong password, in the same shape as the right one', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/console/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'operator@example.test', password: 'not the password',
      }).toString(),
      redirect: 'manual',
    });
    // Refused and answered, not redirected, and carrying no session. A wrong
    // password must not be distinguishable from an unknown address, which is
    // why this is the same 401 either way rather than a "no such user".
    expect(response.status).toBe(401);
    expect((response.headers.getSetCookie?.() ?? []).join(' ')).not.toMatch(/detent_console=\w/);
  });
});
