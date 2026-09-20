/**
 * Server-rendered HTML for the operator console and the customer app.
 *
 * Deliberately server-rendered with no client framework. The console is an
 * internal tool that shows money and takes irreversible actions; the cheapest
 * way to keep it honest is to have no client state to get out of step with the
 * server, and no build step between the code and what an operator sees.
 *
 * Everything interpolated into a page goes through `escape`. There is no
 * "trusted" string here: an account name, an operator's reason for a refund and
 * a tenant's own configuration all arrive from outside and all get escaped.
 */

import { MONEY_CAPABILITIES } from '@detent/awa-console';

export function escape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Tagged template that escapes every interpolation. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((accumulated, part, index) => {
    if (index === 0) return part;
    const value = values[index - 1];
    // An array of already-rendered fragments is joined, not escaped again.
    const rendered = Array.isArray(value) ? value.join('') : escape(value);
    return accumulated + rendered + part;
  }, '');
}

/** Marks a string as already-safe HTML. Used only for composed fragments. */
export function raw(value: string): string[] {
  return [value];
}

export interface PageOptions {
  readonly title: string;
  readonly site: 'console' | 'app';
  readonly nav?: readonly { readonly href: string; readonly label: string; readonly current?: boolean }[];
  readonly user?: string;
  readonly banner?: string;
}


/**
 * The Detent mark: an amber dot, a chevron, and the word.
 *
 * Drawn rather than typed. The character that looks closest, a black
 * left-pointing triangle, is a filled wedge where the logo is a thin stroked
 * chevron, and it renders differently on every platform because it is a font
 * glyph rather than a shape. The chevron takes its colour from the text
 * around it, so the mark works on the dark header and on a light page without
 * a second version existing to fall out of date.
 */
export function brandMark(): string {
  return `<svg class="mark" viewBox="0 0 42 24" width="29" height="17" aria-hidden="true"
   focusable="false" style="vertical-align:-3px;margin-right:7px">
  <circle cx="6.5" cy="12" r="5.5" fill="#EFA13C"/>
  <path d="M33 5.5 L25 12 L33 18.5" fill="none" stroke="currentColor" stroke-width="3"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

export function page(options: PageOptions, body: string): string {
  const nav = (options.nav ?? [])
    .map((item) => `<a href="${escape(item.href)}"${item.current ? ' class="current"' : ''}>${escape(item.label)}</a>`)
    .join('');
  const label = options.site === 'console' ? 'Back office' : 'Manage';
  const banner = options.banner ? `<div class="banner">${escape(options.banner)}</div>` : '';
  const who = options.user ? `<span class="who">${escape(options.user)}</span>` : '';

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(options.title)}, Detent</title>
<link rel="stylesheet" href="/backoffice.css">
</head>
<body>
<header>
  <a class="brand" href="${options.site === 'console' ? '/console' : '/app'}"
     aria-label="Detent, back to the home screen">
    ${brandMark()}Detent</a>
  <span class="tag">${escape(label)}</span>
  <nav>${nav}${who}</nav>
</header>
<main>
${banner}
${body}
<footer>Detent ${escape(label)}. Every commercial action on this site is recorded
in the tenant's hash-chained audit log with the operator's name against it.</footer>
</main>
</body>
</html>`;
}

export function statCard(label: string, value: string, note?: string): string {
  return `<div class="card stat"><div class="label">${escape(label)}</div>
<div class="value">${escape(value)}</div>${note ? `<div class="note">${escape(note)}</div>` : ''}</div>`;
}

export function pill(text: string, tone: 'ok' | 'warn' | 'bad' | 'neutral' = 'neutral'): string {
  const cls = tone === 'neutral' ? 'pill' : `pill ${tone}`;
  return `<span class="${cls}">${escape(text)}</span>`;
}

/**
 * Refusing a write the signed-in user may not make.
 *
 * Says which capability was needed and which roles they hold, because "not
 * permitted" with no detail sends somebody to an administrator who also cannot
 * tell what to grant. Names the MFA requirement separately when that is the
 * reason, since the remedy is theirs rather than an administrator's.
 */
export function forbiddenPage(input: {
  capability: string;
  roles: readonly string[];
  mfaEnrolled: boolean;
}): string {
  const mfaIsTheReason = !input.mfaEnrolled && MONEY_CAPABILITIES.includes(
    input.capability as (typeof MONEY_CAPABILITIES)[number],
  );
  const reason = mfaIsTheReason
    ? 'This moves money, so it needs multi-factor authentication. Set it up on '
      + 'your own account and try again.'
    : `Your roles (${input.roles.join(', ') || 'none'}) do not include it. `
      + 'An owner can grant it.';
  return [
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    '<title>Not permitted</title>',
    '<style>body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,',
    'sans-serif;background:#F6F8FB;color:#16202B;display:flex;min-height:100vh;',
    'align-items:center;justify-content:center;padding:24px}',
    'main{max-width:34rem;background:#fff;border:1px solid #E3E8EF;border-radius:14px;padding:30px}',
    'h1{font-size:20px;margin:0 0 8px}p{color:#42536B;margin:0 0 12px}',
    'code{background:#EEF2F6;padding:2px 6px;border-radius:5px;font-size:14px}</style>',
    '</head><body><main>',
    '<h1>Not permitted</h1>',
    `<p>This action needs <code>${escape(input.capability)}</code>. ${escape(reason)}</p>`,
    '<p><a href="/console">Back to the console</a></p>',
    '</main></body></html>',
  ].join('');
}
