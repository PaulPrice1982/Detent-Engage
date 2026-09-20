import {
  AwaError, isAwaError, newId, silentLogger,
  type Jurisdiction, type Logger, type MetricsRegistry, type TenantConfig,
} from '@detent/awa-core';
import { allTime, type ReportWindow } from '@detent/awa-analytics';
import { evaluatePublishGate } from '@detent/awa-studio';
import { generateLiaTemplate } from '@detent/awa-followup';
import { measureDetection } from '@detent/awa-knowledge';
import type { Session, TurnResult } from '@detent/awa-agent';
import type { SpokenAudio } from '@detent/awa-voice';
import { ApiKeyService, assertOriginAllowed, type Audience, type Principal } from './auth.js';
import { ChangeEventProcessor, parseChangeEvent } from './webhooks.js';
import { RequestRateLimiter, rateLimitError } from './rate-limit.js';
import { localeBundle, negotiateLocale } from './locales.js';
import type { SelfServeService } from './self-serve.js';
import type { Platform } from './platform.js';

/**
 * The public API surface, expressed as a transport-agnostic router.
 *
 * Keeping the handlers free of Node's http types means the same routes are
 * exercised by the test suite directly, by the demo, and by the HTTP server,
 * so the cross-tenant probe suite tests the real authorisation path rather than
 * a mock of it.
 */
export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly rawBody?: string;
  /** Parsed query string. Reports are linkable and shareable (audit UX-10). */
  readonly query?: Readonly<Record<string, string>>;
  /** Client address, for the per-IP limiter (audit SEC-2). */
  readonly ip?: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * A server-sent-event stream, where the route produces one. The HTTP
   * transport writes it; the router stays free of Node types.
   */
  readonly stream?: AsyncIterable<{ event: string; data: unknown }>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): ApiResponse => ({ status, body, headers });

export interface ApiOptions {
  readonly keys?: ApiKeyService;
  readonly events?: ChangeEventProcessor;
  readonly webhookSecrets?: Map<string, string>;
  readonly limiter?: RequestRateLimiter;
  readonly logger?: Logger;
  readonly metrics?: MetricsRegistry;
  /** Self-serve trial and OAuth connect (audit BIZ-7). Absent means no trials. */
  readonly selfServe?: SelfServeService;
}

export class Api {
  readonly keys: ApiKeyService;
  readonly limiter: RequestRateLimiter;
  private readonly events: ChangeEventProcessor;
  private readonly webhookSecrets: Map<string, string>;
  private readonly logger: Logger;
  private readonly metrics?: MetricsRegistry;
  private readonly selfServe?: SelfServeService;

  constructor(private readonly platform: Platform, options: ApiOptions | ApiKeyService = {}) {
    // Historically the second argument was the key service. Kept working so
    // the demo, the tests and any existing deployment do not have to change.
    const opts: ApiOptions = options instanceof ApiKeyService ? { keys: options } : options;
    this.keys = opts.keys ?? new ApiKeyService();
    this.events = opts.events ?? new ChangeEventProcessor(platform.audit);
    this.webhookSecrets = opts.webhookSecrets ?? new Map();
    this.limiter = opts.limiter ?? new RequestRateLimiter();
    this.logger = opts.logger ?? silentLogger;
    this.metrics = opts.metrics;
    this.selfServe = opts.selfServe;
  }

  setWebhookSecret(connector: string, secret: string): void {
    this.webhookSecrets.set(connector, secret);
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    // Every request carries a correlation id from here on. The 500 path used to
    // swallow an unexpected error into `{error:'INTERNAL'}` with no log line and
    // no id, which leaves an operator blind during an incident (audit SEC-10).
    const correlationId = request.headers['x-correlation-id'] ?? newId('req', Date.now());
    const started = Date.now();
    try {
      const response = await this.route(request, correlationId);
      this.observe(request, response.status, started);
      // One line per request, so an on-call engineer can find a request at all.
      // Deliberately the route label rather than the path, and no body and no
      // headers: a log line is the easiest place in a system to leak a
      // credential, and an authorisation header travels on every request.
      this.logger.info('request', {
        correlationId,
        method: request.method,
        path: routeLabel(request.path),
        status: response.status,
        durationMs: Date.now() - started,
      });
      return this.withRequestId(response, correlationId);
    } catch (cause) {
      if (isAwaError(cause)) {
        this.logger.warn('request refused', {
          correlationId, path: request.path, method: request.method,
          kind: cause.kind, message: cause.message, details: cause.details,
        });
        const response = json(statusFor(cause), {
          error: cause.kind,
          message: cause.visitorMessage,
          correlation_id: cause.correlationId ?? correlationId,
        });
        this.observe(request, response.status, started);
        return this.withRequestId(response, cause.correlationId ?? correlationId);
      }
      this.logger.error('unhandled error', {
        correlationId, path: request.path, method: request.method,
        error: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack : undefined,
      });
      this.observe(request, 500, started);
      return this.withRequestId(json(500, {
        error: 'INTERNAL',
        message: 'Something went wrong at our end.',
        // Returned so a visitor's screenshot is enough to find the log line.
        correlation_id: correlationId,
      }), correlationId);
    }
  }

  /**
   * The correlation id on the response as well as in the log.
   *
   * Without it the id exists only in a log line the caller cannot see, so
   * "which request was that" has no answer from the outside: a customer
   * reporting a problem can quote the header instead of a timestamp.
   */
  private withRequestId(response: ApiResponse, correlationId: string): ApiResponse {
    return {
      ...response,
      headers: { ...(response.headers ?? {}), 'x-request-id': correlationId },
    };
  }

  private observe(request: ApiRequest, status: number, startedMs: number): void {
    this.metrics?.observe(
      'awa_http_request_duration_ms',
      'API request duration in milliseconds',
      Date.now() - startedMs,
      { method: request.method, route: routeLabel(request.path), status: String(status) },
    );
  }

  private async route(request: ApiRequest, correlationId: string): Promise<ApiResponse> {
    const segments = request.path.split('/').filter(Boolean);
    const [version, resource, ...rest] = segments;

    /**
     * Liveness: is this process running and able to answer.
     *
     * Every spelling a platform might use, because which one it asks for is
     * the platform's choice and not ours, and a probe that 404s is read as a
     * dead container and restarted for ever. Answered before anything else in
     * the router so no later branch can shadow it.
     *
     * Liveness only. The platform kill-switch state used to be disclosed
     * unauthenticated, which told an attacker exactly when to push (SEC-10).
     */
    if (request.method === 'GET'
      && ['/health', '/healthz', '/_health', '/livez'].includes(request.path)) {
      return json(200, { status: 'ok' });
    }

    /**
     * Readiness: is this process able to serve real traffic yet.
     *
     * Distinct from liveness on purpose. A process that is alive but whose
     * stores are in memory should still be restarted rather than sent traffic
     * in a deployment, and the two questions have different answers during a
     * rollout. `durable` is measured from the stores rather than declared, so
     * this reports what is actually wired.
     */
    if (request.method === 'GET' && request.path === '/readyz') {
      return json(200, {
        status: 'ready',
        durable: this.platform.durable,
      });
    }

    if (version !== 'v1') return json(404, { error: 'NOT_FOUND', message: 'Unknown route.' });

    // Webhooks authenticate by signature, not by API key.
    if (resource === 'webhooks') return this.handleWebhook(request, rest[0]);

    // Locale bundles are public: the panel needs them before a session exists,
    // and they contain nothing but UI copy (audit UX-6).
    if (resource === 'locales' && request.method === 'GET') {
      const locale = negotiateLocale(rest[0] ?? request.query?.['locale'] ?? 'en-GB');
      return json(200, localeBundle(locale), { 'cache-control': 'public, max-age=3600' });
    }

    /**
     * Self-serve trial (audit BIZ-7).
     *
     * Unauthenticated by necessity, this is the sign-up, and therefore rate
     * limited by IP like any other public route. The tenant it creates starts
     * in REGISTERED with no DPA and no CRM, so nothing it can do reaches
     * anything.
     */
    if (resource === 'trials' && request.method === 'POST' && rest.length === 0) {
      if (!this.platform.features.selfServeTrial || !this.selfServe) {
        return json(501, { error: 'NOT_FOUND', message: 'Self-serve trials are not enabled on this deployment.' });
      }
      const allowed = await this.limiter.checkSessionOpen({ keyId: 'trial', ip: request.ip ?? 'unknown' });
      if (!allowed.allowed) throw rateLimitError(allowed);
      const result = await this.selfServe.startTrial((request.body ?? {}) as never);
      this.logger.info('trial started', { correlationId, tenantId: result.tenantId });
      return json(201, result);
    }

    // The OAuth callback carries its own single-use, tenant-bound state rather
    // than a bearer token: the CRM redirects the tenant's browser here.
    if (resource === 'oauth' && rest[0] === 'callback' && request.method === 'GET') {
      if (!this.selfServe) return json(501, { error: 'NOT_FOUND', message: 'OAuth connect is not configured.' });
      const state = request.query?.['state'];
      const code = request.query?.['code'];
      if (!state || !code) return json(400, { error: 'SCHEMA_INVALID', message: 'state and code are required.' });
      const completed = await this.selfServe.complete(state, code);
      return json(200, { connected: completed.connector, tenant_id: completed.tenantId });
    }

    const principal = this.keys.authenticate(bearerHeader(request.headers));

    switch (resource) {
      case 'sessions': return this.handleSessions(request, principal, rest, correlationId);
      case 'admin': return this.handleAdmin(request, principal, rest);
      case 'outcomes': return this.handleOutcomes(request, principal, rest);
      case 'metrics': return this.handleMetrics(principal);
      default: return json(404, { error: 'NOT_FOUND', message: 'Unknown route.' });
    }
  }

  /** Prometheus exposition, behind the platform-admin audience. */
  private handleMetrics(principal: Principal): ApiResponse {
    this.keys.assertAudience(principal, 'platform_admin');
    if (!this.metrics) return json(501, { error: 'NOT_FOUND', message: 'Metrics are not configured.' });
    return { status: 200, body: this.metrics.render(), headers: { 'content-type': 'text/plain; version=0.0.4' } };
  }

  // --- visitor-facing -----------------------------------------------------

  private async handleSessions(
    request: ApiRequest,
    principal: Principal,
    rest: string[],
    correlationId: string,
  ): Promise<ApiResponse> {
    this.keys.assertAudience(principal, 'widget', 'tenant_admin');
    const config = this.platform.effectiveConfig(principal.tenantId);
    // Origin binding, enforced at authentication rather than only at CORS,
    // because CORS is enforced by a browser and a bot farm does not run one.
    assertOriginAllowed(principal, request.headers['origin'], config.origins);
    const ip = request.ip ?? 'unknown';

    if (request.method === 'POST' && rest.length === 0) {
      const opened = await this.limiter.checkSessionOpen({ keyId: principal.keyId, ip });
      if (!opened.allowed) throw rateLimitError(opened);

      const body = (request.body ?? {}) as {
        jurisdiction?: Jurisdiction; modality?: 'text' | 'voice';
        consent?: Record<string, boolean>; locale?: string;
      };

      // The spend cap is checked before a session is opened as well as before
      // every model call: opening a session itself costs money (audit SEC-2a).
      const meter = await this.platform.metering.check(principal.tenantId, config.spendCaps);
      if (meter.state === 'BLOCKED') {
        throw new AwaError({
          kind: meter.reason === 'spend_cap' ? 'SPEND_CAP_REACHED' : 'QUOTA_EXCEEDED',
          message: `tenant blocked: ${meter.reason}`,
          visitorMessage: config.bookingLinkUrl
            ? 'The assistant is unavailable right now, but you can still book a time with the team.'
            : 'The assistant is unavailable right now. Someone from the team can pick this up.',
          tenantId: principal.tenantId,
          details: { bookingLinkUrl: config.bookingLinkUrl },
        });
      }

      const session = await this.platform.openSession(
        principal.tenantId,
        body.jurisdiction ?? config.homeJurisdiction,
        body.modality ?? 'text',
      );

      // The widget reads the host page's consent signal rather than setting its
      // own. A widget that sets identifiers regardless of the host's consent
      // state makes the platform complicit in the tenant's breach (table 35).
      if (body.consent?.['identity_resolution'] === true) {
        await this.platform.consent.record({
          tenantId: principal.tenantId,
          subjectRef: session.subjectRef,
          purpose: 'IDENTITY_RESOLUTION',
          choice: 'GRANTED',
          wordingShown: 'Host consent management platform reported an affirmative signal for personalisation.',
          source: 'HOST_CMP',
          jurisdiction: session.jurisdiction,
          correlationId: session.correlationId,
        });
      }

      const locale = negotiateLocale(body.locale ?? config.locales.default, config.locales.supported);
      const overrides = config.locales.overrides?.[locale];
      const disclosure = session.modality === 'voice'
        ? overrides?.voiceDisclosure ?? config.disclosure.voiceText
        : overrides?.disclosure ?? config.disclosure.text;

      /**
       * On a voice session the disclosure is spoken, and it is spoken first.
       *
       * Article 50 disclosure that only appears as text above a spoken
       * conversation is not disclosure to someone who is listening rather
       * than reading, and on a phone there is no banner at all. So the audio
       * is returned with the session, before any turn exists, and the panel
       * plays it before it will let anyone speak. This is the same rule
       * `GovernedVoiceSession.start` enforces on the realtime path.
       *
       * It goes through the same gate as every other spoken word: the
       * disclosure is the tenant's approved configured wording, not something
       * a model produced, which is what makes it approvable.
       */
      const spokenDisclosure = session.modality === 'voice'
        ? await speakOrCarryOn(this.platform, this.logger,
          { session, text: disclosure, reason: 'disclosure' })
        : undefined;

      return json(201, {
        session_id: session.id,
        // The disclosure is returned at session open so the widget can render
        // it before the first message, in the surface itself.
        disclosure,
        ...spokenPayload(spokenDisclosure),
        // Whether this deployment can actually speak, so the panel shows a
        // microphone only where pressing it would do something.
        voice_available: this.platform.canSpeak,
        modality: session.modality,
        text_only_route_available: true,
        kill_switch: config.killSwitch,
        locale,
        // Everything the panel needs to render itself without a second call.
        branding: config.branding,
        privacy_policy_url: config.privacyPolicyUrl,
        consent_wording: overrides?.consentWording,
        streaming_available: this.platform.features.streaming,
        max_input_chars: this.limiter.limits.maxInputChars,
      });
    }

    const sessionId = rest[0];
    if (!sessionId) return json(404, { error: 'NOT_FOUND', message: 'Unknown route.' });
    const session = this.platform.sessions.get(sessionId);
    if (!session) return json(404, { error: 'NOT_FOUND', message: 'Unknown session.' });
    // Session ownership is checked against the key's tenant, not the payload.
    this.keys.assertTenantAccess(principal, session.tenantId);

    /**
     * Replay a session's turns (audit UX-4).
     *
     * The panel lives in an iframe that is destroyed on every page navigation,
     * so the thread used to reset silently each time a visitor moved from
     * pricing to case studies, and each reset opened a new session, which
     * inflated the conversation meter and therefore the tenant's bill.
     */
    if (request.method === 'GET' && rest.length === 1) {
      return json(200, {
        session_id: session.id,
        state: session.state,
        modality: session.modality,
        locale: config.locales.default,
        disclosure_shown: session.disclosureShown,
        turns: session.history.map((message) => ({
          role: message.role, text: message.text, at: message.at,
        })),
      });
    }

    if (request.method === 'POST' && (rest[1] === 'messages' || rest[1] === 'stream')) {
      const body = (request.body ?? {}) as { text?: string };
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        return json(400, { error: 'SCHEMA_INVALID', message: 'A message is required.' });
      }
      if (body.text.length > this.limiter.limits.maxInputChars) {
        return json(400, {
          error: 'SCHEMA_INVALID',
          message: `A message must be ${this.limiter.limits.maxInputChars} characters or fewer.`,
        });
      }
      const allowed = await this.limiter.checkMessage({ keyId: principal.keyId, ip, sessionId: session.id });
      if (!allowed.allowed) throw rateLimitError(allowed);

      const turnInput = {
        session,
        config: this.platform.effectiveConfig(session.tenantId),
        visitorInput: body.text,
      };

      if (rest[1] === 'stream') {
        if (!this.platform.features.streaming) {
          return json(501, { error: 'NOT_FOUND', message: 'Streaming is not enabled on this deployment.' });
        }
        const orchestrator = this.platform.orchestrator;
        const logger = this.logger;
        return {
          status: 200,
          body: undefined,
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' },
          stream: (async function* () {
            const run = orchestrator.runStreaming(turnInput);
            try {
              let next = await run.next();
              while (!next.done) {
                yield { event: 'sentence', data: { text: next.value.text } };
                next = await run.next();
              }
              yield { event: 'done', data: turnPayload(next.value) };
            } catch (cause) {
              logger.error('streamed turn failed', {
                correlationId, error: cause instanceof Error ? cause.message : String(cause),
              });
              yield {
                event: 'error',
                data: { message: 'Something went wrong at our end.', correlation_id: correlationId },
              };
            }
          })(),
        };
      }

      const result = await this.platform.orchestrator.run(turnInput);
      // Only on a voice session, and only after the orchestrator returned:
      // `result.text` is validated text, which is the one thing that may be
      // spoken. Nothing else in this file reaches the synthesiser.
      const spoken = session.modality === 'voice'
        ? await speakOrCarryOn(this.platform, this.logger,
          { session, text: result.text, reason: 'reply' })
        : undefined;
      return json(200, { ...turnPayload(result), ...spokenPayload(spoken) });
    }

    /**
     * Switch a session between typing and speaking.
     *
     * Modality is a property of the session and not of the request, because
     * three things hang off it: which disclosure wording applies, whether a
     * reply is synthesised, and what the visitor is billed for. A panel that
     * sent `speak: true` on individual turns would be deciding governance a
     * message at a time.
     *
     * Switching *into* voice re-discloses, in the voice wording, and speaks
     * it. That is not belt and braces. The text disclosure a visitor read on
     * the first screen said they were typing to an AI assistant; the voice
     * wording is the tenant's separate, configured sentence, and someone who
     * has just put their microphone on is about to stop reading the screen.
     * `session.disclosureShown` is set here for the same reason it is set on
     * the realtime path: the pipeline must not later decide that disclosure
     * is still outstanding and say it a third time.
     */
    if (request.method === 'POST' && rest[1] === 'modality') {
      const body = (request.body ?? {}) as { modality?: string };
      if (body.modality !== 'text' && body.modality !== 'voice') {
        return json(400, {
          error: 'SCHEMA_INVALID',
          message: 'modality must be "text" or "voice".',
        });
      }
      if (body.modality === 'voice' && !this.platform.canSpeak) {
        return json(409, {
          error: 'NOT_FOUND',
          message: 'This deployment serves the text assistant only.',
        });
      }

      const already = session.modality === body.modality;
      session.modality = body.modality;
      if (body.modality === 'text' || already) {
        return json(200, { modality: session.modality, voice_available: this.platform.canSpeak });
      }

      const locale = negotiateLocale(config.locales.default, config.locales.supported);
      const wording = config.locales.overrides?.[locale]?.voiceDisclosure
        ?? config.disclosure.voiceText;
      session.disclosureShown = true;
      await this.platform.audit.write({
        tenantId: session.tenantId,
        type: 'disclosure_shown',
        correlationId: session.correlationId,
        sessionId: session.id,
        actor: 'system',
        payload: { modality: 'voice', wording },
        versions: session.versions,
      });
      const spoken = await speakOrCarryOn(this.platform, this.logger,
        { session, text: wording, reason: 'disclosure' });
      return json(200, {
        modality: session.modality,
        voice_available: true,
        disclosure: wording,
        ...spokenPayload(spoken),
      });
    }

    if (request.method === 'POST' && rest[1] === 'consent') {
      const body = (request.body ?? {}) as { purpose?: string; granted?: boolean; wording?: string };
      if (!body.purpose || typeof body.granted !== 'boolean' || !body.wording) {
        return json(400, { error: 'SCHEMA_INVALID', message: 'purpose, granted and wording are required.' });
      }
      const event = await this.platform.consent.record({
        tenantId: session.tenantId,
        subjectRef: session.subjectRef,
        purpose: body.purpose as 'IDENTITY_RESOLUTION' | 'MARKETING' | 'RECORDING' | 'TRANSCRIPTION',
        choice: body.granted ? 'GRANTED' : 'REFUSED',
        // The exact wording shown, stored verbatim. This is the evidence.
        wordingShown: body.wording,
        source: 'WIDGET_PROMPT',
        jurisdiction: session.jurisdiction,
        correlationId: session.correlationId,
      });
      return json(201, { consent_event_id: event.id, choice: event.choice });
    }

    /**
     * "Forget me" (audit UX-8).
     *
     * A refusal recorded against the purpose, the session's transcript dropped,
     * and the erasure itself audited. The audit entry is deliberately kept,
     * the evidence that an erasure happened cannot itself be erased, and it
     * holds no personal data, because payloads are redacted before they land.
     */
    if (request.method === 'POST' && rest[1] === 'forget') {
      await this.platform.consent.record({
        tenantId: session.tenantId,
        subjectRef: session.subjectRef,
        purpose: 'IDENTITY_RESOLUTION',
        choice: 'REFUSED',
        wordingShown: 'Visitor asked to be forgotten from within the conversation.',
        source: 'WIDGET_PROMPT',
        jurisdiction: session.jurisdiction,
        correlationId: session.correlationId,
      });
      await this.platform.audit.write({
        tenantId: session.tenantId, type: 'erasure_executed',
        correlationId: session.correlationId, sessionId: session.id, actor: 'visitor',
        payload: { scope: 'session_transcript', requestedInConversation: true },
      });
      // The part-minute of speech this session has not been charged for is
      // settled before the session goes, or it goes with it. Erasure removes
      // the transcript, not the bill.
      await this.platform.settleSpokenMinutes(session);
      this.platform.sessions.end(session.id);
      await this.limiter.forgetSession(session.id);
      return json(200, { forgotten: true });
    }

    return json(404, { error: 'NOT_FOUND', message: 'Unknown route.' });
  }

  // --- tenant and platform administration ---------------------------------

  private async handleAdmin(request: ApiRequest, principal: Principal, rest: string[]): Promise<ApiResponse> {
    this.keys.assertAudience(principal, 'tenant_admin', 'platform_admin');
    const [collection, tenantId, action] = rest;

    if (collection === 'kill-switch' && request.method === 'POST') {
      this.keys.assertAudience(principal, 'platform_admin');
      const body = (request.body ?? {}) as { mode?: 'OFF' | 'TEXT_ONLY' | 'BOOKING_LINK_ONLY' };
      this.platform.platformKillSwitch = body.mode ?? 'OFF';
      await this.platform.audit.write({
        tenantId: '*platform*', type: 'kill_switch_engaged',
        correlationId: `kill_${Date.now()}`, actor: 'platform_admin',
        payload: { mode: this.platform.platformKillSwitch },
      });
      return json(200, { kill_switch: this.platform.platformKillSwitch });
    }

    if (collection === 'status' && request.method === 'GET') {
      // The authenticated counterpart of `/health`. A tenant admin sees whether
      // their evidence is durable and whether the platform is degraded, because
      // both change what their own screens mean; the operational counters are
      // for the platform admin.
      const base = {
        kill_switch: this.platform.platformKillSwitch,
        // Stated plainly (audit SEC-3). A deployment on the in-memory stores
        // loses its audit chain on restart, and the person operating the
        // console is exactly the person who should know that.
        durable: this.platform.durable,
        features: this.platform.features,
      };
      if (principal.audience !== 'platform_admin') return json(200, base);
      return json(200, {
        ...base,
        sessions: this.platform.sessions.size,
        rate_limiter_entries: this.limiter.size,
      });
    }

    if (collection !== 'tenants' || !tenantId) {
      return json(404, { error: 'NOT_FOUND', message: 'Unknown route.' });
    }
    this.keys.assertTenantAccess(principal, tenantId);

    if (request.method === 'GET' && !action) {
      return json(200, redactConfig(this.platform.tenants.get(tenantId)));
    }

    if (request.method === 'PATCH' && !action) {
      const updated = await this.platform.tenants.update(
        tenantId, (request.body ?? {}) as never, principal.audience,
      );
      return json(200, redactConfig(updated));
    }

    switch (action) {
      case 'audit': {
        // The exportable audit trail, with its own chain verification attached,
        // is what a tenant DPO asks for and what makes the governance claim
        // checkable rather than asserted. Paginated (audit SEC-10): the
        // unpaginated version materialised a tenant's whole chain twice.
        const page = await this.platform.audit.export(tenantId, {
          sinceSequence: numberParam(request, 'since'),
          toSequence: numberParam(request, 'to'),
          limit: numberParam(request, 'limit'),
        });
        return json(200, { entries: page.entries, verification: page.verification, page: page.page });
      }
      case 'replay': {
        const target = request.query?.['correlation_id'] ?? (request.body as { correlationId?: string } | undefined)?.correlationId;
        if (!target) return json(400, { error: 'SCHEMA_INVALID', message: 'correlation_id is required.' });
        return json(200, await this.platform.assurance.replay(tenantId, target));
      }
      case 'usage': {
        const usage = await this.platform.metering.usage(tenantId);
        const perConversation = await this.platform.metering.costPerConversationPence(tenantId);
        return json(200, { usage, cost_per_conversation_pence: perConversation });
      }
      case 'keys': {
        // Key lifecycle, visible and operable (audit SEC-8).
        if (request.method === 'GET') return json(200, { keys: this.keys.list(tenantId) });
        if (request.method === 'POST') {
          const body = (request.body ?? {}) as {
            audience?: Audience; label?: string; origins?: string[]; ttlDays?: number; rotate?: string;
          };
          if (body.rotate) {
            const rotated = this.keys.rotate(body.rotate);
            await this.platform.audit.write({
              tenantId, type: 'policy_allowed', correlationId: `key_${Date.now()}`,
              actor: auditActor(principal),
              payload: { change: 'api_key_rotated', from: body.rotate, to: rotated.record.id },
            });
            // Shown once. There is no route that returns it again.
            return json(201, { key: rotated.key, record: this.keys.list(tenantId).find((k) => k.id === rotated.record.id) });
          }
          const audience: Audience = body.audience === 'tenant_admin' ? 'tenant_admin' : 'widget';
          if (audience === 'tenant_admin') this.keys.assertAudience(principal, 'tenant_admin', 'platform_admin');
          const issued = this.keys.issue(tenantId, audience, {
            label: body.label,
            origins: body.origins,
            ttlMs: body.ttlDays ? body.ttlDays * 86_400_000 : undefined,
          });
          await this.platform.audit.write({
            tenantId, type: 'policy_allowed', correlationId: `key_${Date.now()}`,
            actor: auditActor(principal),
            payload: { change: 'api_key_issued', keyId: issued.record.id, audience },
          });
          return json(201, { key: issued.key, record: this.keys.list(tenantId).find((k) => k.id === issued.record.id) });
        }
        if (request.method === 'DELETE') {
          const keyId = request.query?.['key_id'] ?? (request.body as { keyId?: string } | undefined)?.keyId;
          if (!keyId) return json(400, { error: 'SCHEMA_INVALID', message: 'key_id is required.' });
          this.keys.revoke(keyId);
          await this.platform.audit.write({
            tenantId, type: 'policy_allowed', correlationId: `key_${Date.now()}`,
            actor: auditActor(principal), payload: { change: 'api_key_revoked', keyId },
          });
          return json(200, { revoked: keyId });
        }
        return json(405, { error: 'SCHEMA_INVALID', message: 'Use GET, POST or DELETE.' });
      }
      case 'origins': {
        /**
         * Install verification (audit SEC-5, UX-10).
         *
         * A tenant declares the origins their assistant runs on, and the
         * platform confirms the snippet is actually present before accepting
         * them. That is both the security control and the "we can see your
         * snippet" step the install page was missing.
         */
        if (request.method === 'GET') {
          return json(200, { origins: this.platform.tenants.get(tenantId).origins });
        }
        if (request.method !== 'POST') {
          return json(405, { error: 'SCHEMA_INVALID', message: 'Use GET or POST.' });
        }
        const body = (request.body ?? {}) as { origins?: string[]; verifyUrl?: string };
        if (!Array.isArray(body.origins) || body.origins.length === 0) {
          return json(400, { error: 'SCHEMA_INVALID', message: 'origins is required.' });
        }
        const invalid = body.origins.filter((origin) => !/^https?:\/\/[^/\s]+$/.test(origin.replace('*.', '')));
        if (invalid.length) {
          return json(400, { error: 'SCHEMA_INVALID', message: `not an origin: ${invalid.join(', ')}` });
        }
        const verification = body.verifyUrl
          ? await this.platform.verifyInstall(tenantId, body.verifyUrl)
          : { verified: false, reason: 'no verification URL supplied' };
        const updated = await this.platform.tenants.applyOperatorPatch(
          tenantId, { origins: body.origins }, 'install verification',
        );
        return json(200, { origins: updated.origins, verification });
      }
      case 'capabilities': {
        const capabilities = await this.platform.adapter.capabilities(tenantId);
        return json(200, capabilities);
      }
      case 'handoffs':
        return json(200, { handoffs: this.platform.handoff.forTenant(tenantId) });
      case 'reconcile': {
        // POST replays the backlog now rather than waiting for the timer,
        // what an operator wants at the moment a CRM comes back (audit PERF-8).
        if (request.method === 'POST') {
          const result = await this.platform.reconciliation.runForTenant(tenantId);
          return json(200, result);
        }
        const pending = await this.platform.receipts.pendingReconciliation(tenantId);
        const backlog = await this.platform.reconciliation.backlog(tenantId);
        return json(200, { pending: pending.length, receipts: pending, backlog });
      }
      case 'analytics': {
        const report = await this.platform.funnel.build(tenantId, this.window(request), this.platform.clock.iso());
        // Value first, cost second (audit BIZ-6). A VP of Sales buys pipeline;
        // the cost-per-conversation headline is a procurement figure, and
        // leading with it trains the buyer to treat this as a cost line.
        return json(200, {
          headline: {
            meetings_held: report.funnel.heldMeetings,
            qualified_leads: report.funnel.qualified,
            deflection_rate_pct: report.deflection.deflectionRatePct,
            implied_hours_saved: report.deflection.impliedHoursSaved,
            outside_business_hours_sessions: report.coverage.outsideBusinessHoursSessions,
          },
          ...report,
        });
      }
      case 'outcome-ledger': {
        /**
         * The customer-visible outcome ledger (audit BIZ-5).
         *
         * The outcome fee asks a customer to trust a ledger. An invoice line a
         * customer can verify is an invoice line they do not dispute, so every
         * row carries its correlation id and drills through to the audit replay.
         */
        const window = this.window(request);
        const outcomes = (await this.platform.outcomes.list(tenantId)).filter(
          (outcome) => outcome.recordedAt >= window.from && outcome.recordedAt <= window.to,
        );
        return json(200, {
          window,
          billable: outcomes.filter((outcome) => outcome.billable && outcome.state === 'CONFIRMED').length,
          rows: outcomes.map((outcome) => ({
            correlation_id: outcome.correlationId,
            outcome: outcome.outcome,
            state: outcome.state,
            billable: outcome.billable,
            recorded_at: outcome.recordedAt,
            confirmed_at: outcome.confirmedAt,
            evidence_url: `/v1/admin/tenants/${tenantId}/replay?correlation_id=${encodeURIComponent(outcome.correlationId)}`,
          })),
        });
      }
      case 'data-quality': {
        const scorecard = await this.platform.dataQuality.build(
          tenantId, this.window(request), this.platform.clock.iso(), this.platform.clock.nowMs(),
        );
        return json(200, scorecard);
      }
      case 'compliance': {
        // The single highest-leverage surface in the extension: a compliance
        // architecture the buyer cannot see, turned into a report they can take
        // to their own board. Machine-readable, any date range, one action.
        const scorecard = await this.platform.compliance.build(tenantId, this.window(request), this.platform.clock.iso());
        return json(200, scorecard, { 'content-disposition': `attachment; filename="compliance-${tenantId}.json"` });
      }
      case 'assurance': {
        if (!this.platform.features.assurancePack) {
          return json(501, { error: 'NOT_FOUND', message: 'The assurance pack is not enabled on this deployment.' });
        }
        const pack = await this.platform.assurance.generate({
          config: this.platform.tenants.get(tenantId),
          window: this.window(request),
          generatedAt: this.platform.clock.iso(),
          sampleCorrelationId: request.query?.['correlation_id'],
          accessibility: this.platform.accessibilityStatement,
        });
        // The measured injection pass rate travels with the pack: a published
        // number is what turns a defence-in-depth claim into evidence (SEC-9).
        return json(200, { ...pack, injectionDetection: measureDetection() });
      }
      case 'generation': {
        if (request.method === 'POST') return this.startGeneration(request, tenantId);
        if (!this.platform.generation) return json(501, { error: 'NOT_FOUND', message: 'Generation is not configured.' });
        const result = this.platform.generation.get(tenantId);
        return json(200, { ...result, coverage: this.platform.generation.coverage(tenantId) });
      }
      case 'approve': {
        if (!this.platform.generation) return json(501, { error: 'NOT_FOUND', message: 'Generation is not configured.' });
        const body = (request.body ?? {}) as { section?: string; items?: string[]; approvedBy?: string; signOff?: boolean };
        if (!body.section || !body.approvedBy) {
          return json(400, { error: 'SCHEMA_INVALID', message: 'section and approvedBy are required.' });
        }
        const correlationId = `approve_${this.platform.clock.nowMs()}`;
        if (body.items?.length) {
          await this.platform.generation.approveItems(tenantId, body.section as never, body.items, body.approvedBy, correlationId);
        }
        if (body.signOff) {
          await this.platform.generation.approveSection(tenantId, body.section as never, body.approvedBy, correlationId);
        }
        return json(200, { coverage: this.platform.generation.coverage(tenantId), fullyApproved: this.platform.generation.fullyApproved(tenantId) });
      }
      case 'dry-run': {
        if (request.method === 'GET') return json(200, this.platform.staging.diff(tenantId));
        if (request.method === 'POST') {
          // Accepting the diff is what enables real CRM writes (FR-036).
          const applied = this.platform.staging.accept(tenantId);
          await this.platform.tenants.applyOperatorPatch(tenantId, { dryRun: false }, 'field mapping dry run accepted');
          return json(200, { applied: applied.length, dryRun: false });
        }
        return json(405, { error: 'SCHEMA_INVALID', message: 'Use GET to review or POST to accept.' });
      }
      case 'playbooks': {
        const versions = this.platform.playbooks.list(tenantId);
        return json(200, {
          versions: versions.map((version) => ({
            version: version.version, author: version.author, publishedAt: version.publishedAt,
            note: version.note, restoredFrom: version.restoredFrom, simulationRunId: version.simulationRunId,
          })),
          active: this.platform.playbooks.activeVersion(tenantId)?.version,
        });
      }
      case 'rollback': {
        const body = (request.body ?? {}) as { version?: number; author?: string };
        if (typeof body.version !== 'number' || !body.author) {
          return json(400, { error: 'SCHEMA_INVALID', message: 'version and author are required.' });
        }
        const restored = await this.platform.playbooks.restore(
          tenantId, body.version, body.author, `rollback_${this.platform.clock.nowMs()}`,
        );
        await this.platform.tenants.applyOperatorPatch(
          tenantId, { playbookVersion: restored.version }, 'playbook rollback',
        );
        return json(200, { version: restored.version, restoredFrom: restored.restoredFrom });
      }
      case 'simulate': {
        if (!this.platform.simulation) return json(501, { error: 'NOT_FOUND', message: 'Simulation is not configured.' });
        const config = this.platform.effectiveConfig(tenantId);
        const scorecard = await this.platform.simulation.run(config, `simulate_${this.platform.clock.nowMs()}`);
        const gate = evaluatePublishGate(scorecard);
        // Blocked, not warned (FR-042).
        return json(gate.allowed ? 200 : 422, { scorecard, publishGate: gate });
      }
      case 'connect': {
        // "Connect HubSpot" as a button rather than a support ticket.
        if (!this.selfServe) return json(501, { error: 'NOT_FOUND', message: 'OAuth connect is not configured.' });
        if (request.method === 'GET') return json(200, { connectors: this.selfServe.availableConnectors });
        if (request.method !== 'POST') return json(405, { error: 'SCHEMA_INVALID', message: 'Use GET or POST.' });
        const body = (request.body ?? {}) as { connector?: string; redirectUri?: string };
        if (!body.connector || !body.redirectUri) {
          return json(400, { error: 'SCHEMA_INVALID', message: 'connector and redirectUri are required.' });
        }
        return json(200, this.selfServe.begin(tenantId, body.connector, body.redirectUri));
      }
      case 'partners': {
        // The partner surface, exposed at last (audit BIZ-7). `PartnerRegistry`
        // was built, tested and reachable from nowhere.
        if (!this.platform.features.groupsAndPartners) {
          return json(501, { error: 'NOT_FOUND', message: 'Partner routing is not enabled on this deployment.' });
        }
        if (request.method === 'GET') return json(200, { partners: this.platform.partners.list(tenantId) });
        if (request.method === 'POST') {
          const body = (request.body ?? {}) as {
            id?: string; name?: string; entityRef?: string; portalUrl?: string;
            territories?: string[]; sectors?: string[]; services?: string[];
            capacity?: number; tier?: 1 | 2 | 3; crmConnected?: boolean;
          };
          if (!body.id || !body.name) {
            return json(400, { error: 'SCHEMA_INVALID', message: 'id and name are required.' });
          }
          this.platform.partners.register(tenantId, {
            partnerId: body.id,
            name: body.name,
            entityId: body.entityRef,
            territories: body.territories ?? [],
            sectors: body.sectors ?? [],
            services: body.services ?? [],
            capacity: body.capacity ?? 0,
            tier: body.tier ?? 3,
            crmConnected: body.crmConnected ?? false,
            portalUrl: body.portalUrl,
          });
          return json(201, { partners: this.platform.partners.list(tenantId) });
        }
        return json(405, { error: 'SCHEMA_INVALID', message: 'Use GET or POST.' });
      }
      case 'lia': {
        if (request.method === 'POST') {
          const body = (request.body ?? {}) as { completedBy?: string };
          if (!body.completedBy) return json(400, { error: 'SCHEMA_INVALID', message: 'completedBy is required.' });
          const current = this.platform.tenants.get(tenantId);
          const updated = await this.platform.tenants.update(tenantId, {
            followUp: {
              ...current.followUp,
              liaComplete: true,
              liaCompletedAt: this.platform.clock.iso(),
              liaCompletedBy: body.completedBy,
            },
          }, principal.audience);
          return json(200, { liaComplete: updated.followUp.liaComplete, completedBy: body.completedBy });
        }
        return json(200, { template: generateLiaTemplate(this.platform.tenants.get(tenantId)) });
      }
      case 'lifecycle': {
        const body = (request.body ?? {}) as { to?: string };
        const updated = await this.platform.tenants.transition(tenantId, body.to as never, principal.audience);
        return json(200, redactConfig(updated));
      }
      default:
        return json(404, { error: 'NOT_FOUND', message: 'Unknown route.' });
    }
  }

  /**
   * Reporting window, from the query string first and the body second.
   *
   * Reading a window only from the request body, including on GETs, meant a
   * dashboard could not link to a report and a link could not be shared
   * (audit UX-10).
   */
  private window(request: ApiRequest): ReportWindow {
    const from = request.query?.['from'] ?? (request.body as { from?: string } | undefined)?.from;
    const to = request.query?.['to'] ?? (request.body as { to?: string } | undefined)?.to;
    if (from && to) return { from, to };
    return allTime();
  }

  private async startGeneration(request: ApiRequest, tenantId: string): Promise<ApiResponse> {
    if (!this.platform.generation) {
      return json(501, { error: 'NOT_FOUND', message: 'Generation is not configured on this deployment.' });
    }
    const body = (request.body ?? {}) as { rootUrl?: string; seedUrls?: string[] };
    if (!body.rootUrl) return json(400, { error: 'SCHEMA_INVALID', message: 'rootUrl is required.' });

    const config = this.platform.tenants.get(tenantId);
    const capabilities = await this.platform.adapter.capabilities(tenantId);
    const owners = await this.platform.adapter.readOwners(tenantId);
    const pipelines = await this.platform.adapter.readPipelines(tenantId);

    const result = await this.platform.generation.generate({
      tenantId,
      rootUrl: body.rootUrl,
      correlationId: `generate_${this.platform.clock.nowMs()}`,
      crawl: { seedUrls: body.seedUrls },
      qualification: config.qualification,
      objections: config.objections,
      // Schema introspection would come from the connector; where a connector
      // does not expose one, the mapping generator returns what it can and the
      // uncovered fields are named rather than silently dropped.
      crmSchemas: [],
      owners,
      pipelines,
      capabilities,
    });

    return json(201, {
      durationMs: result.durationMs,
      knowledge: { items: result.knowledge.items.length, pagesCrawled: result.knowledge.pagesCrawled },
      playbook: {
        approvalState: result.playbook.approvalState,
        services: result.playbook.serviceCatalogue.length,
        prices: result.playbook.priceList.length,
        claims: result.playbook.approvedClaims.length,
      },
      mapping: { standardFieldCoverage: result.mapping.standardFieldCoverage, unmapped: result.mapping.unmapped },
      routing: { rules: result.routing.rules.length, ownerCount: result.routing.ownerCount },
      // Stated back explicitly so nobody can claim they thought it was live.
      nothingServesUntilApproved: true,
    });
  }

  /**
   * Outcome confirmation callback (FR-046).
   *
   * Audit SEC-1: this route had no audience check, and the comment claimed it
   * was "authenticated by signature" when it was in fact authenticated by
   * bearer token. Any holder of a widget key, which is, by design, in the HTML
   * of every page on the tenant's website, could mark outcomes succeeded or
   * failed, and those records drive the per-outcome fee, the funnel and the
   * data-quality scorecard. Two things fixed it: the audience assertion, and
   * an HMAC signature the route actually verifies when the tenant has
   * configured a signing key.
   */
  private async handleOutcomes(request: ApiRequest, principal: Principal, rest: string[]): Promise<ApiResponse> {
    this.keys.assertAudience(principal, 'tenant_admin', 'platform_admin');
    const [correlationId, action] = rest;
    if (!correlationId || action !== 'confirm' || request.method !== 'POST') {
      return json(404, { error: 'NOT_FOUND', message: 'Unknown route.' });
    }

    const config = this.platform.tenants.get(principal.tenantId);
    const signingKeyRef = config.outcomes.trialProvisioning?.signingKeyRef;
    if (signingKeyRef) {
      const secret = this.webhookSecrets.get(signingKeyRef);
      const signature = request.headers['x-signature'] ?? '';
      if (!secret || !this.events.verifySignature(secret, request.rawBody ?? '', signature)) {
        throw new AwaError({
          kind: 'POLICY_DENIED',
          message: 'outcome confirmation signature did not verify',
          tenantId: principal.tenantId,
        });
      }
    }

    const body = (request.body ?? {}) as { succeeded?: boolean; reason?: string };
    const confirmed = await this.platform.outcomes.confirm(principal.tenantId, correlationId, {
      succeeded: body.succeeded !== false,
      reason: body.reason,
    });
    return json(200, { outcome: confirmed.outcome, state: confirmed.state, billable: confirmed.billable });
  }

  // --- inbound CRM change events ------------------------------------------

  private async handleWebhook(request: ApiRequest, connector: string | undefined): Promise<ApiResponse> {
    if (!connector || request.method !== 'POST') {
      return json(404, { error: 'NOT_FOUND', message: 'Unknown route.' });
    }
    const secret = this.webhookSecrets.get(connector);
    const signature = request.headers['x-signature'] ?? '';
    const verified = Boolean(secret) && this.events.verifySignature(secret!, request.rawBody ?? '', signature);

    const event = parseChangeEvent(request.body);
    const outcome = await this.events.process(event, { signatureVerified: verified });
    return json(outcome === 'rejected_signature' ? 401 : 202, { outcome });
  }
}

/** The wire shape of a completed turn. Shared by the JSON and SSE routes. */
function turnPayload(result: TurnResult): Record<string, unknown> {
  return {
    text: result.text,
    disclosure: result.disclosure,
    escalated: result.escalated,
    correlation_id: result.correlationId,
    // The visitor's route on, rendered as a card rather than left implicit.
    next_action: result.nextAction,
    degraded: result.degraded,
  };
}

/**
 * The spoken half of a payload, or nothing.
 *
 * Base64 in the JSON rather than a second request for an audio URL. A URL
 * would have to be guessable or signed, would live long enough to be shared,
 * and would put a visitor's spoken conversation behind a cacheable GET. The
 * audio is a few tens of kilobytes and it belongs to exactly one response.
 */
function spokenPayload(spoken: SpokenAudio | undefined): Record<string, unknown> {
  if (!spoken) return {};
  return {
    audio: Buffer.from(spoken.audio).toString('base64'),
    audio_media_type: spoken.mediaType,
    audio_duration_ms: spoken.durationMs,
  };
}

/**
 * Speak a reply without letting a vendor outage silence the conversation.
 *
 * A failed synthesis is not a failed turn. The words were produced, governed
 * and are on screen; losing the audio is a degradation of one modality and
 * the text route is always available. Throwing here would turn a vendor's
 * bad afternoon into a visitor seeing nothing at all.
 */
async function speakOrCarryOn(
  platform: Platform,
  logger: Logger,
  input: { session: Session; text: string; reason: 'disclosure' | 'reply' },
): Promise<SpokenAudio | undefined> {
  if (!platform.canSpeak) return undefined;
  try {
    return await platform.speakApproved({ ...input, approved: true });
  } catch (cause) {
    logger.warn('the reply could not be spoken; the text stands', {
      sessionId: input.session.id,
      reason: input.reason,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return undefined;
  }
}

/** Audit actors are a narrower set than key audiences; a widget key that
 *  reaches an admin route has already been refused, so this never widens. */
function auditActor(principal: Principal): 'tenant_admin' | 'platform_admin' {
  return principal.audience === 'platform_admin' ? 'platform_admin' : 'tenant_admin';
}

function numberParam(request: ApiRequest, key: string): number | undefined {
  const raw = request.query?.[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Route label for metrics. Ids are collapsed so the series stays bounded. */
function routeLabel(path: string): string {
  return path
    .split('/')
    .map((segment) => (/^(sess|corr|t|ak|pers)_|^[0-9a-f-]{16,}$/.test(segment) ? ':id' : segment))
    .join('/');
}

function bearerHeader(headers: Readonly<Record<string, string | undefined>>): string | undefined {
  const header = headers['authorization'] ?? headers['Authorization'];
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

function statusFor(error: AwaError): number {
  switch (error.kind) {
    case 'POLICY_DENIED': return 403;
    case 'CONSENT_REQUIRED': return 403;
    case 'SCHEMA_INVALID': return 400;
    case 'TENANT_NOT_FOUND':
    case 'NOT_FOUND': return 404;
    case 'CONFLICT': return 409;
    case 'RATE_LIMITED': return 429;
    case 'QUOTA_EXCEEDED':
    case 'SPEND_CAP_REACHED': return 402;
    case 'UPSTREAM_UNAVAILABLE':
    case 'CONNECTION_DEGRADED': return 503;
    default: return 500;
  }
}

/** Configuration is returned without anything that is not the tenant's to see. */
function redactConfig(config: TenantConfig): Record<string, unknown> {
  return {
    tenant_id: config.tenantId,
    name: config.name,
    version: config.version,
    state: config.state,
    residency: config.residency,
    connector: config.connector,
    kill_switch: config.killSwitch,
    disclosure: config.disclosure,
    service_catalogue: config.serviceCatalogue,
    price_list: config.priceList,
    qualification: config.qualification,
    escalation: config.escalation,
    spend_caps: config.spendCaps,
    retention: config.retention,
    recording: config.recording,
    origins: config.origins,
    locales: config.locales,
    branding: config.branding,
    privacy_policy_url: config.privacyPolicyUrl,
    dry_run: config.dryRun,
    versions: {
      prompt: config.promptVersion,
      policy: config.policyVersion,
      model: config.modelVersion,
    },
    dpa_signed_at: config.dpaSignedAt,
    field_mapping_accepted_at: config.fieldMappingAcceptedAt,
  };
}
