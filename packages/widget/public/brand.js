/**
 * Detent brand tokens and mark.
 *
 * Inlined rather than fetched: the widget must not require a network round trip
 * for its own logo, and an external image would need an allowlist entry in
 * every tenant's Content Security Policy.
 */
export const BRAND = {
    ink: '#0F1B2A',
    ink2: '#1B2A3D',
    amber: '#EFA13C',
    paper: '#FFFFFF',
    slate: '#5B6B7F',
    line: '#E3E8EF',
};
/**
 * The mark: an amber dot and a left chevron. Sized to the current font, so it
 * scales with the launcher rather than being pinned to a pixel size.
 */
export function detentMark(height = 16) {
    const w = height * 1.6;
    return `<svg viewBox="0 0 32 20" width="${w}" height="${height}" role="img" aria-label="Detent" focusable="false">
  <circle cx="6" cy="10" r="5" fill="${BRAND.amber}"/>
  <path d="M27 3 L18 10 L27 17" fill="none" stroke="currentColor" stroke-width="2.6"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}
/** Full lockup: mark plus wordmark, for the panel header. */
export function detentLockup(height = 18) {
    return `<span style="display:inline-flex;align-items:center;gap:8px;color:currentColor">
  ${detentMark(height)}
  <span style="font-weight:700;letter-spacing:-0.01em;font-size:${height}px">Detent</span>
</span>`;
}
