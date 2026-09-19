/**
 * Customer branding for the widget.
 *
 * The assistant sits on the customer's own website, so it wears the customer's
 * logo, not ours. Three problems have to be solved before that is safe or
 * looks right, and each one is a place this normally goes wrong.
 *
 * **1. A logo is not one shape.** Customers supply a square mark, a wide
 * wordmark eight times wider than it is tall, a stacked lockup, or a circular
 * badge. A launcher pill 48 pixels high cannot show a wordmark next to a text
 * label without one of them becoming illegible. So shape decides placement
 * rather than the other way round.
 *
 * **2. A logo is not one colour.** The launcher takes the customer's accent
 * colour, which may be near-black or near-white. A dark logo on a dark launcher
 * disappears. So contrast is computed, a light-on-dark variant is used when one
 * is supplied, and a white chip is placed behind the logo when one is not.
 *
 * **3. A customer-supplied SVG is executable.** An SVG can carry `<script>`,
 * event handlers and `javascript:` references. Inlining one into the widget's
 * shadow DOM would run it on the customer's own site under their origin ,
 * stored cross-site scripting, shipped by us. Every customer logo is therefore
 * rendered inside an `<img>`, where an SVG cannot execute, and never inlined.
 * Detent's own mark stays inline because it is ours and it is a constant.
 */
const MAX_SOURCE_LENGTH = 512 * 1024;
/** Aspect-ratio classification. */
export function classifyShape(widthPx, heightPx) {
    if (widthPx <= 0 || heightPx <= 0)
        return 'mark';
    const ratio = widthPx / heightPx;
    if (ratio < 0.85)
        return 'tall';
    if (ratio <= 1.4)
        return 'mark';
    if (ratio <= 3)
        return 'lockup';
    return 'wordmark';
}
/**
 * Validates a logo before it is ever rendered.
 *
 * Runs where the logo is accepted, the customer's manage app, so a bad asset
 * is refused at upload with a reason, rather than rendering wrongly on a live
 * website where the customer sees it before we do.
 */
export function validateLogo(logo) {
    const problems = [];
    if (!logo.altText.trim()) {
        // The launcher is a control. An unlabelled image inside it is unusable with
        // a screen reader, so alt text is required rather than encouraged.
        problems.push({ field: 'altText', message: 'Alt text is required; use the organisation name.' });
    }
    if (logo.widthPx <= 0 || logo.heightPx <= 0) {
        problems.push({ field: 'size', message: 'Width and height must both be positive.' });
    }
    if (logo.source.length > MAX_SOURCE_LENGTH) {
        problems.push({ field: 'source', message: 'The logo exceeds 512KB. Supply an SVG or a compressed PNG.' });
    }
    const scheme = schemeOf(logo.source);
    if (scheme === 'other') {
        problems.push({
            field: 'source',
            message: 'A logo must be a data: URI or an https URL.',
        });
    }
    if (scheme === 'data' && !dataUriMatchesFormat(logo.source, logo.format)) {
        problems.push({
            field: 'source',
            message: `The data URI does not carry a ${logo.format} image.`,
        });
    }
    if (logo.format === 'jpeg' && !logo.needsPadding) {
        // A JPEG has no transparency, so its corners are opaque. Placed straight
        // onto a coloured launcher it reads as a rectangle stuck on, not a logo.
        problems.push({
            field: 'format',
            message: 'A JPEG has no transparency and will show a box. Supply SVG or PNG, or set needsPadding.',
        });
    }
    // Checked against the real launcher box rather than a ratio guess, so the
    // message is true of the surface the customer will actually look at.
    if (logo.widthPx > 0 && logo.heightPx > 0) {
        const scale = Math.min(LAUNCHER_BOX.maxHeightPx / logo.heightPx, LAUNCHER_BOX.maxWidthPx / logo.widthPx, 1);
        if (logo.heightPx * scale < MIN_LEGIBLE_HEIGHT_PX) {
            problems.push({
                field: 'size',
                message: 'This logo is too wide to read on the launcher, so initials will be shown there instead. ' +
                    'Supply a square mark as well to have your logo appear on the launcher.',
            });
        }
    }
    return problems;
}
function schemeOf(source) {
    const value = source.trim().toLowerCase();
    if (value.startsWith('data:image/'))
        return 'data';
    if (value.startsWith('https://'))
        return 'https';
    return 'other';
}
function dataUriMatchesFormat(source, format) {
    const head = source.slice(0, 40).toLowerCase();
    const expected = format === 'svg' ? 'data:image/svg+xml' : `data:image/${format}`;
    // PNG, WebP and JPEG all state their own type; SVG has the +xml suffix.
    return head.startsWith(expected) || (format === 'jpeg' && head.startsWith('data:image/jpg'));
}
/**
 * Relative luminance, per WCAG. Used to decide whether a logo needs a light
 * variant or a chip behind it.
 */
export function luminanceOf(colour) {
    const rgb = parseColour(colour);
    if (!rgb)
        return undefined;
    const channel = (value) => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
function parseColour(colour) {
    const value = colour.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
    if (hex) {
        const digits = hex[1];
        const full = digits.length === 3
            ? digits.split('').map((digit) => digit + digit).join('')
            : digits;
        return [
            parseInt(full.slice(0, 2), 16),
            parseInt(full.slice(2, 4), 16),
            parseInt(full.slice(4, 6), 16),
        ];
    }
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value);
    if (rgb)
        return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    // A named or modern colour function is not parsed. Undefined means "assume
    // the worst and use a chip", which is the safe direction to be wrong in.
    return undefined;
}
/**
 * Below this height a logo is a smudge rather than a mark.
 *
 * It is a legibility floor, not a ratio rule, because that is the thing that
 * actually matters: a 10:1 wordmark scaled to fit a launcher lands at nine
 * pixels tall and cannot be read at any ratio. Where the floor is breached the
 * launcher shows a monogram instead and the real logo goes in the panel header,
 * which has the width to carry it.
 */
export const MIN_LEGIBLE_HEIGHT_PX = 12;
/** The launcher pill: short, and already carrying a label and the AI badge. */
export const LAUNCHER_BOX = { maxHeightPx: 18, maxWidthPx: 92 };
/** The panel header: room for a full wordmark. */
export const PANEL_HEADER_BOX = { maxHeightPx: 24, maxWidthPx: 168 };
/**
 * Works out how to draw a logo in a given box.
 *
 * Scales to fit *both* dimensions rather than pinning height, because pinning
 * height is exactly what makes a wide wordmark overflow a launcher, and pinning
 * width is what makes a tall logo push the pill out of shape.
 */
export function planLogo(logo, box, options = {}) {
    const shape = classifyShape(logo.widthPx, logo.heightPx);
    const scale = Math.min(box.maxHeightPx / logo.heightPx, box.maxWidthPx / logo.widthPx, 1);
    const width = Math.max(1, Math.round(logo.widthPx * scale));
    const height = Math.max(1, Math.round(logo.heightPx * scale));
    const luminance = options.backgroundColour ? luminanceOf(options.backgroundColour) : undefined;
    // Undefined luminance means the colour could not be parsed. A chip is the
    // safe answer: it is slightly less elegant and always legible.
    const darkBackground = luminance === undefined ? true : luminance < 0.5;
    let treatment = 'direct';
    let source = logo.source;
    if (darkBackground) {
        if (logo.onDark) {
            treatment = 'variant';
            source = logo.onDark;
        }
        else {
            treatment = 'chip';
        }
    }
    // A JPEG is opaque whatever the background, so it always sits on a chip;
    // without one its own white corners read as a rectangle stuck onto the pill.
    if (logo.format === 'jpeg' || logo.needsPadding)
        treatment = 'chip';
    // A logo scaled below the legibility floor is not shown at all. Showing an
    // unreadable smear of a customer's wordmark is worse than showing their
    // initials, because it looks like the widget is broken rather than deliberate.
    const useMonogram = height < MIN_LEGIBLE_HEIGHT_PX;
    // On the launcher a wordmark replaces the text label rather than sitting
    // beside it: two pieces of horizontal text in a pill is one too many, and the
    // logo is the one the customer cares about. A monogram is short, so the label
    // stays.
    const hideLabel = Boolean(options.isLauncher) && !useMonogram
        && (shape === 'wordmark' || shape === 'lockup');
    return {
        shape, treatment, source, widthPx: width, heightPx: height,
        hideLabel, useMonogram, altText: logo.altText,
    };
}
/**
 * A monogram, used when no logo is supplied or the image fails to load.
 *
 * A broken-image icon on a customer's own website is worse than no logo at all,
 * so there is always something to fall back to. Initials are taken from the
 * organisation name, ignoring the corporate suffixes that would otherwise turn
 * "Northwind Trading Ltd" into "NTL".
 */
const SUFFIXES = new Set([
    'ltd', 'limited', 'plc', 'llp', 'lp', 'inc', 'llc', 'gmbh', 'bv', 'nv',
    'sa', 'srl', 'spa', 'ag', 'oy', 'ab', 'as', 'group', 'holdings', 'co',
]);
export function monogramOf(organisationName) {
    const words = organisationName
        // The slash is kept through the split so that a slashed suffix: the Danish
        // A/S, the Norwegian AS, survives as one token and can be recognised.
        // Splitting it first turns "Ørsted A/S" into initials Ø and A.
        .replace(/[^\p{L}\p{N}\s&/-]/gu, ' ')
        .split(/[\s-]+/)
        .filter((word) => word.length > 0)
        .filter((word) => !SUFFIXES.has(word.toLowerCase().replace(/[./]/g, '')));
    if (words.length === 0)
        return '?';
    if (words.length === 1)
        return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}
