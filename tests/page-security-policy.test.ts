/**
 * The content security policy a page actually receives.
 *
 * This exists because the policy was chosen from the file extension in the
 * request path, and every page this server renders is served from a path with
 * no extension: the whole back office, the whole customer area, the reseller
 * portal and every sign-in page. All of them were given the API policy,
 * `default-src 'none'`, which refuses the page's own stylesheet.
 *
 * Nothing failed. No status was wrong, no handler threw, and curl, which
 * enforces no policy, showed correct HTML. The only symptom was that every
 * screen arrived in a real browser as an unstyled document, which is why it
 * survived: the suite asserted on the HTML and the HTML was right.
 *
 * So these assertions are about the header and the markup together. A page
 * must be served a policy that permits a same-origin stylesheet and a
 * same-origin form post, and must link its stylesheet rather than inline it,
 * because either one alone is the broken state.
 */
import { describe, expect, it } from 'vitest';
import { type AddressInfo } from 'node:net';
import { createHttpServer, type Api, type ApiRequest, type ApiResponse } from '@detent/awa-server';
import { page } from '@detent/awa-server';

const api = {
  async handle(_request: ApiRequest): Promise<ApiResponse> {
    return { status: 200, body: { ok: true } };
  },
} as unknown as Api;

/** Answers HTML at every path that is not the API's, as the real mount does. */
const SITE = {
  prefix: '',
  async handle(request: { path: string }) {
    if (request.path.startsWith('/v1/')) return undefined;
    return { status: 200, html: '<p>site</p>' };
  },
};

async function headersFor(path: string): Promise<Record<string, string>> {
  const server = createHttpServer(api, { sites: [SITE], panelFrameAncestors: ['https://acme.example'] });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    return headers;
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

function directives(policy: string): Map<string, string> {
  return new Map(policy.split(';').map((part) => {
    const [name, ...rest] = part.trim().split(/\s+/);
    return [name ?? '', rest.join(' ')];
  }));
}

describe('a rendered page', () => {
  // Every one of these is a real path in the product and none of them has an
  // extension, which is exactly the shape the old rule got wrong.
  it.each(['/console', '/console/signin', '/console/approvals', '/app', '/app/billing', '/portal'])(
    '%s is served the page policy, not the API one',
    async (path) => {
      const policy = directives((await headersFor(path))['content-security-policy'] ?? '');
      expect(policy.get('default-src')).toBe("'self'");
      expect(policy.get('style-src')).toBe("'self'");
    },
  );

  it('may load its own stylesheet', async () => {
    const policy = directives((await headersFor('/console'))['content-security-policy'] ?? '');
    // 'none' here is the bug: the page links a stylesheet on this origin and
    // the browser refuses it, silently.
    expect(policy.get('style-src')).not.toBe("'none'");
    expect(policy.get('style-src')).toContain("'self'");
  });

  it('may post its own forms back to itself', async () => {
    // `form-action` does not fall back to `default-src`, so this one is not
    // fixed by the directive above and has to be asserted on its own. With
    // 'none' nobody can sign in.
    const policy = directives((await headersFor('/console/signin'))['content-security-policy'] ?? '');
    expect(policy.get('form-action')).toBe("'self'");
  });

  it('still refuses a third-party script and being framed', async () => {
    const policy = directives((await headersFor('/console'))['content-security-policy'] ?? '');
    expect(policy.get('script-src')).toBe("'self'");
    expect(policy.get('frame-ancestors')).toBe("'none'");
  });
});

describe('the API', () => {
  it('keeps the strictest policy', async () => {
    const policy = directives((await headersFor('/v1/sessions'))['content-security-policy'] ?? '');
    expect(policy.get('default-src')).toBe("'none'");
  });
});

describe('the visitor panel', () => {
  it('is framed by the tenant that embedded it, and by nobody else', async () => {
    const policy = directives((await headersFor('/widget/panel.html'))['content-security-policy'] ?? '');
    expect(policy.get('frame-ancestors')).toBe('https://acme.example');
  });
});

describe('the page renderer', () => {
  it('links its stylesheet rather than inlining it', async () => {
    // An inline <style> is dropped under `style-src 'self'`. The header and
    // the markup have to agree, and asserting only one of them is how this
    // got shipped.
    const html = page({ title: 'Accounts', site: 'console' }, '<p>body</p>');
    expect(html).toContain('<link rel="stylesheet"');
    expect(html).not.toContain('<style>');
  });
});
