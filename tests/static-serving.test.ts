import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveStaticPath, type StaticMount } from '@detent/awa-server';

/**
 * The static layer is the smallest surface in the product and the one most
 * likely to be attacked, because it is the only place a URL becomes a
 * filesystem path. These tests pin that mapping.
 */
const ROOT: StaticMount = { prefix: '', dir: resolve('/srv/app/public') };
const WIDGET: StaticMount = { prefix: '/widget', dir: resolve('/srv/app/widget') };

describe('static path resolution', () => {
  it('serves the index for the mount root', () => {
    expect(resolveStaticPath(ROOT, '/')).toBe(resolve('/srv/app/public/index.html'));
  });

  it('serves the index for a prefixed mount root with no trailing slash', () => {
    expect(resolveStaticPath(WIDGET, '/widget')).toBe(resolve('/srv/app/widget/index.html'));
  });

  it('resolves a named file under a prefix', () => {
    expect(resolveStaticPath(WIDGET, '/widget/panel.html')).toBe(resolve('/srv/app/widget/panel.html'));
  });

  it('ignores a path outside its prefix', () => {
    expect(resolveStaticPath(WIDGET, '/health')).toBeUndefined();
    // `/widgets` must not match the `/widget` mount by prefix alone.
    expect(resolveStaticPath(WIDGET, '/widgetry/x.html')).toBeUndefined();
  });

  it('refuses a literal parent-directory traversal', () => {
    expect(resolveStaticPath(ROOT, '/../package.json')).toBeUndefined();
    expect(resolveStaticPath(WIDGET, '/widget/../../package.json')).toBeUndefined();
  });

  it('refuses a percent-encoded traversal', () => {
    // Encoding is where naive checks fail: the raw string holds no `..`.
    expect(resolveStaticPath(ROOT, '/%2e%2e%2fpackage.json')).toBeUndefined();
    expect(resolveStaticPath(WIDGET, '/widget/%2e%2e/%2e%2e/db/migrations/0001_init.sql')).toBeUndefined();
  });

  it('refuses a deeply nested traversal that normalises back out', () => {
    expect(resolveStaticPath(ROOT, '/a/b/../../../../etc/passwd')).toBeUndefined();
  });

  it('refuses a NUL byte, which truncates a path in some syscalls', () => {
    expect(resolveStaticPath(ROOT, '/index.html%00.png')).toBeUndefined();
  });

  it('refuses malformed percent-encoding rather than guessing', () => {
    expect(resolveStaticPath(ROOT, '/%zz')).toBeUndefined();
  });

  it('permits a nested path that stays inside the mount', () => {
    expect(resolveStaticPath(ROOT, '/assets/img/logo.svg')).toBe(
      resolve('/srv/app/public/assets/img/logo.svg'),
    );
  });

  it('refuses an interior traversal even though it would land inside the mount', () => {
    // Normalising an absolute path clamps traversal at the root, so this would
    // be safe either way. It is refused so that a served path is always exactly
    // the path requested, with no silent rewriting to reason about.
    expect(resolveStaticPath(ROOT, '/assets/../logo.svg')).toBeUndefined();
  });
});
