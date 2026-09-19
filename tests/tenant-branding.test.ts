import { describe, expect, it } from 'vitest';
import {
  LAUNCHER_BOX, PANEL_HEADER_BOX, classifyShape, luminanceOf, monogramOf,
  MIN_LEGIBLE_HEIGHT_PX, planLogo, validateLogo, type TenantLogo,
} from '@detent/awa-widget/tenant-brand';

const logo = (over: Partial<TenantLogo> = {}): TenantLogo => ({
  source: 'data:image/svg+xml;base64,PHN2Zy8+',
  format: 'svg',
  widthPx: 120,
  heightPx: 120,
  altText: 'Northwind Trading',
  ...over,
});

describe('logo shapes', () => {
  it('classifies the shapes customers actually supply', () => {
    expect(classifyShape(120, 120)).toBe('mark');        // square mark
    expect(classifyShape(64, 64)).toBe('mark');          // favicon-style
    expect(classifyShape(140, 100)).toBe('mark');        // slightly wide mark
    expect(classifyShape(300, 120)).toBe('lockup');      // mark plus short word
    expect(classifyShape(600, 120)).toBe('wordmark');    // wordmark
    expect(classifyShape(1200, 150)).toBe('wordmark');   // very wide wordmark
    expect(classifyShape(100, 240)).toBe('tall');        // stacked lockup
  });

  it('treats a circular badge as a mark', () => {
    expect(classifyShape(200, 200)).toBe('mark');
  });

  it('does not classify a zero-sized logo as tall', () => {
    expect(classifyShape(0, 0)).toBe('mark');
  });
});

describe('fitting a logo to the launcher', () => {
  it('scales a square mark to the launcher height', () => {
    const plan = planLogo(logo(), LAUNCHER_BOX, { backgroundColour: '#0F1B2A' });
    expect(plan.heightPx).toBe(18);
    expect(plan.widthPx).toBe(18);
  });

  it('constrains a wide wordmark by width, not height', () => {
    // Pinning height is exactly what makes a wordmark overflow the pill.
    const plan = planLogo(logo({ widthPx: 1200, heightPx: 150 }), LAUNCHER_BOX);
    expect(plan.widthPx).toBeLessThanOrEqual(LAUNCHER_BOX.maxWidthPx);
    expect(plan.heightPx).toBeLessThanOrEqual(LAUNCHER_BOX.maxHeightPx);
    expect(plan.shape).toBe('wordmark');
  });

  it('constrains a tall logo by height, so the pill keeps its shape', () => {
    const plan = planLogo(logo({ widthPx: 100, heightPx: 240 }), LAUNCHER_BOX);
    expect(plan.heightPx).toBe(18);
    expect(plan.widthPx).toBeLessThan(18);
  });

  it('never enlarges a small logo beyond its natural size', () => {
    // Upscaling a 12px favicon to 18px is how a crisp mark turns into mush.
    const plan = planLogo(logo({ widthPx: 12, heightPx: 12 }), LAUNCHER_BOX);
    expect(plan.heightPx).toBe(12);
  });

  it('hides the text label for a wordmark, which would otherwise compete', () => {
    const plan = planLogo(logo({ widthPx: 600, heightPx: 120 }), LAUNCHER_BOX, { isLauncher: true });
    expect(plan.hideLabel).toBe(true);
  });

  it('keeps the label beside a square mark', () => {
    const plan = planLogo(logo(), LAUNCHER_BOX, { isLauncher: true });
    expect(plan.hideLabel).toBe(false);
  });

  it('gives a wordmark more room in the panel header than the launcher', () => {
    const wide = logo({ widthPx: 1200, heightPx: 150 });
    const header = planLogo(wide, PANEL_HEADER_BOX);
    const launcher = planLogo(wide, LAUNCHER_BOX);
    expect(header.widthPx).toBeGreaterThan(launcher.widthPx);
  });
});

describe('contrast', () => {
  it('reads luminance from hex and rgb', () => {
    expect(luminanceOf('#FFFFFF')).toBeCloseTo(1, 2);
    expect(luminanceOf('#000000')).toBeCloseTo(0, 2);
    expect(luminanceOf('#fff')).toBeCloseTo(1, 2);
    expect(luminanceOf('rgb(255, 255, 255)')).toBeCloseTo(1, 2);
  });

  it('uses a chip on a dark launcher when no light variant was supplied', () => {
    // Otherwise a dark logo simply disappears into the pill.
    const plan = planLogo(logo(), LAUNCHER_BOX, { backgroundColour: '#0F1B2A' });
    expect(plan.treatment).toBe('chip');
  });

  it('prefers a supplied light variant over a chip', () => {
    const plan = planLogo(
      logo({ onDark: 'data:image/svg+xml;base64,LIGHT' }),
      LAUNCHER_BOX,
      { backgroundColour: '#0F1B2A' },
    );
    expect(plan.treatment).toBe('variant');
    expect(plan.source).toBe('data:image/svg+xml;base64,LIGHT');
  });

  it('draws directly on a light launcher', () => {
    const plan = planLogo(logo(), LAUNCHER_BOX, { backgroundColour: '#FFFFFF' });
    expect(plan.treatment).toBe('direct');
  });

  it('falls back to a chip when the colour cannot be parsed', () => {
    // Being slightly less elegant is the safe direction to be wrong in.
    const plan = planLogo(logo(), LAUNCHER_BOX, { backgroundColour: 'oklch(0.7 0.1 200)' });
    expect(plan.treatment).toBe('chip');
  });

  it('always chips a JPEG, whatever the background', () => {
    // A JPEG has no transparency, so its own corners read as a stuck-on box.
    const plan = planLogo(
      logo({ format: 'jpeg', needsPadding: true }),
      LAUNCHER_BOX,
      { backgroundColour: '#FFFFFF' },
    );
    expect(plan.treatment).toBe('chip');
  });
});

describe('validation at upload', () => {
  it('accepts a well-formed SVG mark', () => {
    expect(validateLogo(logo())).toEqual([]);
  });

  it('requires alt text, because the launcher is a control', () => {
    expect(validateLogo(logo({ altText: '   ' })).map((problem) => problem.field))
      .toContain('altText');
  });

  it('refuses a source that is neither data: nor https', () => {
    for (const source of ['http://example.com/logo.png', 'javascript:alert(1)', '//evil/logo.svg']) {
      expect(validateLogo(logo({ source })).map((problem) => problem.field)).toContain('source');
    }
  });

  it('refuses a data URI whose type contradicts the declared format', () => {
    const problems = validateLogo(logo({
      source: 'data:image/png;base64,AAAA', format: 'svg',
    }));
    expect(problems.map((problem) => problem.field)).toContain('source');
  });

  it('warns that a JPEG will show a box unless it is padded', () => {
    expect(validateLogo(logo({ format: 'jpeg', source: 'data:image/jpeg;base64,AAAA' }))
      .map((problem) => problem.field)).toContain('format');
  });

  it('refuses a logo too wide to stay legible at widget size', () => {
    expect(validateLogo(logo({ widthPx: 2000, heightPx: 100 }))
      .map((problem) => problem.field)).toContain('size');
  });

  it('refuses a logo without intrinsic dimensions', () => {
    expect(validateLogo(logo({ widthPx: 0, heightPx: 0 }))
      .map((problem) => problem.field)).toContain('size');
  });

  it('refuses an oversized asset rather than shipping it to every visitor', () => {
    expect(validateLogo(logo({ source: `data:image/svg+xml;base64,${'A'.repeat(600_000)}` }))
      .map((problem) => problem.field)).toContain('source');
  });
});

describe('the monogram fallback', () => {
  it('takes initials from the first two meaningful words', () => {
    expect(monogramOf('Northwind Trading')).toBe('NT');
  });

  it('ignores corporate suffixes', () => {
    // Otherwise "Northwind Trading Ltd" becomes NT anyway but "Acme Ltd"
    // becomes AL, which is not the company's initials.
    expect(monogramOf('Acme Ltd')).toBe('AC');
    expect(monogramOf('Acme Holdings Limited')).toBe('AC');
    expect(monogramOf('Bright GmbH')).toBe('BR');
  });

  it('uses two letters of a single-word name', () => {
    expect(monogramOf('Monzo')).toBe('MO');
  });

  it('survives punctuation and non-Latin names', () => {
    expect(monogramOf('Ørsted A/S')).toBe('ØR');
    expect(monogramOf('北京 科技')).toBe('北科');
  });

  it('never returns an empty string', () => {
    expect(monogramOf('   ')).toBe('?');
    expect(monogramOf('!!!')).toBe('?');
  });
});

describe('the legibility floor', () => {
  it('shows initials rather than an unreadable wordmark on the launcher', () => {
    // A 10:1 wordmark scaled to the launcher lands at nine pixels tall. An
    // unreadable smear of a customer's logo looks like a broken widget, which
    // is worse than showing their initials deliberately.
    const plan = planLogo(logo({ widthPx: 1000, heightPx: 100 }), LAUNCHER_BOX, { isLauncher: true });
    expect(plan.useMonogram).toBe(true);
    // The label stays, because a monogram is short and leaves room for it.
    expect(plan.hideLabel).toBe(false);
  });

  it('still shows that same wordmark in the panel header, which has the width', () => {
    const plan = planLogo(logo({ widthPx: 1000, heightPx: 100 }), PANEL_HEADER_BOX);
    expect(plan.useMonogram).toBe(false);
    expect(plan.heightPx).toBeGreaterThanOrEqual(MIN_LEGIBLE_HEIGHT_PX);
  });

  it('keeps a 6:1 wordmark on the launcher, which is still readable', () => {
    const plan = planLogo(logo({ widthPx: 600, heightPx: 100 }), LAUNCHER_BOX, { isLauncher: true });
    expect(plan.useMonogram).toBe(false);
    expect(plan.hideLabel).toBe(true);
  });

  it('warns at upload rather than letting the customer discover it live', () => {
    const problems = validateLogo(logo({ widthPx: 1000, heightPx: 100 }));
    expect(problems.map((problem) => problem.field)).toContain('size');
    expect(problems.some((problem) => /square mark/i.test(problem.message))).toBe(true);
  });
});
