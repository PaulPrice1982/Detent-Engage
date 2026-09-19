/**
 * Nothing a person would mind reaching a log reaches one.
 *
 * The other redaction tests check `redactText` and `redactObject` against
 * strings chosen to exercise them. This one asserts the property end to end:
 * it drives the golden path through the real API with every log line captured,
 * and then looks for the actual values it fed in. A redactor that is correct
 * and not wired to the path a visitor's details travel down protects nothing,
 * and that gap is invisible to a unit test of the redactor.
 *
 * The values below are deliberately distinctive so that finding one in a log
 * line is unambiguous rather than a coincidence of formatting.
 */
import { describe, expect, it } from 'vitest';
import { JsonLogger } from '@detent/awa-core';
import { bearer, buildHarness } from './fixtures/tenant.js';

const VISITOR = {
  email: 'gwendolyn.ashworth-pike@examplecustomer.test',
  phone: '07700 900321',
  card: '4111 1111 1111 1111',
  postcode: 'EC1A 1BB',
  nationalInsurance: 'QQ123456C',
};

/** A key shaped like a real one, so a leak of it looks like a leak of one. */
const CREDENTIAL = 'sk-ant-api03-notarealkeybutshapedlikeone0123456789';

describe('the golden path, with every log line read back', () => {
  it('writes no visitor detail and no credential into any log line', async () => {
    const lines: string[] = [];
    const logger = new JsonLogger({
      // Everything, not just what a deployment would keep. A value that only
      // appears at debug is still a value in a log somewhere.
      level: 'debug',
      sink: (line) => lines.push(line),
    });

    const harness = await buildHarness({
      logger,
      script: [{
        match: /.*/,
        output: { text: 'Thank you. What are you trying to solve?', confidence: 0.9 },
      }],
    });

    const session = await harness.api.handle({
      method: 'POST',
      path: '/v1/sessions',
      headers: bearer(harness.widgetKey),
      body: { jurisdiction: 'UK' },
    });
    expect(session.status).toBe(201);
    const sessionId = (session.body as { sessionId: string }).sessionId;

    // A visitor who volunteers everything at once, which is what they do.
    await harness.api.handle({
      method: 'POST',
      path: '/v1/messages',
      headers: { ...bearer(harness.widgetKey), authorization: `Bearer ${harness.widgetKey}` },
      body: {
        sessionId,
        text: `I am ${VISITOR.email}, call me on ${VISITOR.phone}. I am at `
          + `${VISITOR.postcode}, my NI is ${VISITOR.nationalInsurance} and my card `
          + `is ${VISITOR.card}. Our key is ${CREDENTIAL}.`,
      },
    });

    // A failure path too: an error is where a payload most often gets logged
    // whole, because whoever wrote the handler wanted to know what went wrong.
    await harness.api.handle({
      method: 'POST',
      path: '/v1/messages',
      headers: bearer(harness.widgetKey),
      body: { sessionId: 'sess_does_not_exist', text: VISITOR.email },
    });

    const written = lines.join('\n');
    expect(lines.length, 'the sweep proves nothing if nothing was logged').toBeGreaterThan(0);

    for (const [what, value] of Object.entries(VISITOR)) {
      expect(written, `${what} reached a log line`).not.toContain(value);
    }
    expect(written, 'an API key reached a log line').not.toContain(CREDENTIAL);
    // The bearer token itself, which travels on every single request.
    expect(written, 'the widget key reached a log line').not.toContain(harness.widgetKey);
    expect(written, 'the admin key reached a log line').not.toContain(harness.adminKey);
  });

  it('logs enough to diagnose a request without logging what it carried', async () => {
    // The opposite failure. A logger that writes nothing passes the test above
    // and leaves an on-call engineer with no way to find a request at all.
    const lines: string[] = [];
    const logger = new JsonLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const harness = await buildHarness({ logger });

    await harness.api.handle({
      method: 'POST',
      path: '/v1/sessions',
      headers: bearer(harness.widgetKey),
      body: { jurisdiction: 'UK' },
    });

    const written = lines.join('\n');
    expect(written).toContain('/v1/sessions');
    // Every line is JSON, so a log pipeline can index it rather than a human
    // reading it with their eyes.
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });
});
