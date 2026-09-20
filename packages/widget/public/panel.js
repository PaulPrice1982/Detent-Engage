const params = new URLSearchParams(location.search);
  const api = params.get('api') ?? '';
  const key = params.get('key') ?? '';
  const jurisdiction = params.get('jurisdiction') ?? 'UK';
  const requestedLocale = params.get('locale') ?? document.documentElement.lang ?? 'en-GB';
  // The host page's consent decision, passed in. The panel never decides it.
  const hostConsent = params.get('consent_personalisation') === 'true';

  const log = document.getElementById('log');
  const composer = document.getElementById('composer');
  const input = document.getElementById('message');
  const send = document.getElementById('send');
  const consentBar = document.getElementById('consent');
  const title = document.getElementById('title');

  let sessionId = null;
  let strings = {};
  let consentWording = '';
  let streamingAvailable = false;
  let maxInputChars = 4000;
  let voiceAvailable = false;
  let speaking = false;

  // --- session persistence (UX-4) ------------------------------------------
  //
  // sessionStorage in a partitioned iframe: per top-level site, cleared when the
  // tab closes, never shared with the host page and never sent anywhere. It can
  // legitimately throw in a private window or with site data blocked, so every
  // access is guarded and the panel works without it.
  const STORE_KEY = `awa:${key.slice(0, 12)}`;
  function remember(id) {
    try { sessionStorage.setItem(STORE_KEY, id); } catch { /* storage unavailable */ }
  }
  function recall() {
    try { return sessionStorage.getItem(STORE_KEY); } catch { return null; }
  }
  function forgetStored() {
    try { sessionStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ }
  }

  // --- rendering -----------------------------------------------------------

  function timeOf(at) {
    try {
      return new Intl.DateTimeFormat(strings.__locale ?? 'en-GB', { hour: '2-digit', minute: '2-digit' })
        .format(at ? new Date(at) : new Date());
    } catch { return ''; }
  }

  function append(role, text, options = {}) {
    const el = document.createElement('div');
    el.className = `turn ${role}`;
    const body = document.createElement('span');
    body.textContent = text;
    el.append(body);
    if (role !== 'system') {
      const stamp = document.createElement('span');
      stamp.className = 'stamp';
      const who = role === 'visitor' ? (strings.you ?? 'You') : (strings.assistant ?? 'Assistant');
      stamp.textContent = `${who} · ${timeOf(options.at)}`;
      el.append(stamp);
    }
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'typing';
    el.id = 'typing';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', strings.thinking ?? 'Assistant is typing');
    el.innerHTML = '<span></span><span></span><span></span>';
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function clearTyping() {
    document.getElementById('typing')?.remove();
  }

  /** The structured next action, rendered as a card rather than a dead end (UX-7). */
  function renderNextAction(action) {
    if (!action || action.kind === 'none') return;
    const card = document.createElement('div');
    card.className = 'card';

    if (action.kind === 'booking_link') {
      const p = document.createElement('p');
      p.textContent = action.label ?? strings.bookingCta ?? 'Book a time with the team';
      const link = document.createElement('a');
      link.className = 'cta';
      link.href = action.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = strings.bookingCta ?? 'Book a time with the team';
      card.append(p, link);
    } else if (action.kind === 'await_human') {
      const p = document.createElement('p');
      // Say explicitly whether a human was actually notified. "Someone will
      // pick this up" with nothing behind it is the dead end the audit named.
      p.textContent = action.promise
        ? `${action.notified ? (strings.awaitHumanNotified ?? '') : (strings.awaitHuman ?? '')} ${action.promise}`.trim()
        : (action.notified ? (strings.awaitHumanNotified ?? '') : (strings.awaitHuman ?? ''));
      card.append(p);
    } else if (action.kind === 'leave_details') {
      const p = document.createElement('p');
      p.textContent = action.prompt ?? strings.leaveDetails ?? '';
      const row = document.createElement('div');
      row.className = 'row';
      const email = document.createElement('input');
      email.type = 'email';
      email.placeholder = strings.emailPlaceholder ?? 'you@company.com';
      email.setAttribute('aria-label', strings.emailPlaceholder ?? 'Email address');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cta';
      button.textContent = strings.leaveDetailsCta ?? 'Send';
      button.addEventListener('click', async () => {
        if (!email.value.trim()) return;
        button.disabled = true;
        // Sent as an ordinary turn: the platform decides what to do with it,
        // under the same policy as anything else the visitor types.
        await submit(email.value.trim(), { silent: true });
        card.replaceChildren(Object.assign(document.createElement('p'), {
          textContent: strings.detailsReceived ?? 'Thank you.',
        }));
      });
      row.append(email, button);
      card.append(p, row);
    }

    log.append(card);
    log.scrollTop = log.scrollHeight;
  }

  // --- transport -----------------------------------------------------------

  async function call(path, body, method = 'POST') {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload.message ?? 'request failed');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return response.json();
  }

  async function loadLocale(locale) {
    try {
      const bundle = await (await fetch(`${api}/v1/locales/${encodeURIComponent(locale)}`)).json();
      strings = { ...bundle.strings, __locale: bundle.locale };
      document.documentElement.lang = bundle.locale;
      document.documentElement.dir = bundle.dir ?? 'ltr';
    } catch {
      // A locale bundle that will not load must not stop the conversation.
      strings = {};
    }
    applyStrings();
  }

  function applyStrings() {
    document.title = strings.title ?? 'Assistant';
    input.placeholder = strings.placeholder ?? 'Type your message';
    send.textContent = strings.send ?? 'Send';
    document.getElementById('close').setAttribute('aria-label', strings.closeHint ?? strings.close ?? 'Close');
    document.getElementById('message-label').textContent = strings.messageLabel ?? 'Your message';
    document.getElementById('consent-explain').textContent = strings.consentExplain ?? 'What does this mean?';
    document.getElementById('consent-explain-body').textContent = strings.consentExplainBody ?? '';
    document.getElementById('consent-yes').textContent = strings.yes ?? 'Yes';
    document.getElementById('consent-no').textContent = strings.no ?? 'No';
    document.getElementById('forget').textContent = strings.forgetMe ?? 'Forget me';
    log.setAttribute('aria-label', strings.conversationLabel ?? 'Conversation');
  }

  function applyBranding(branding) {
    if (!branding) return;
    if (branding.accentColour) document.documentElement.style.setProperty('--accent', branding.accentColour);
    if (branding.fontFamily) document.documentElement.style.setProperty('--font', branding.fontFamily);
    if (branding.assistantName) document.getElementById('assistant-name').textContent = branding.assistantName;
    if (branding.avatarUrl) {
      const avatar = document.getElementById('avatar');
      avatar.src = branding.avatarUrl;
      avatar.hidden = false;
      document.getElementById('mark').setAttribute('hidden', '');
    }
  }

  // --- session lifecycle ---------------------------------------------------

  async function open() {
    await loadLocale(requestedLocale);

    const existing = recall();
    if (existing) {
      try {
        const replayed = await call(`/v1/sessions/${existing}`, undefined, 'GET');
        sessionId = replayed.session_id;
        for (const turn of replayed.turns ?? []) {
          append(turn.role === 'visitor' ? 'visitor' : 'assistant', turn.text, { at: turn.at });
        }
        return;
      } catch {
        // Expired or unknown: fall through and open a fresh one.
        forgetStored();
      }
    }

    const created = await call('/v1/sessions', {
      jurisdiction,
      modality: 'text',
      locale: requestedLocale,
      consent: { identity_resolution: hostConsent },
    });
    sessionId = created.session_id;
    remember(sessionId);
    document.getElementById('disclosure').textContent = created.disclosure;
    streamingAvailable = created.streaming_available === true;
    voiceAvailable = created.voice_available === true;
    // Only offered where pressing it would do something. A microphone on a
    // deployment that cannot speak is worse than no microphone: the visitor
    // grants a permission and gets silence.
    micButton.hidden = !voiceAvailable || !SpeechRecogniser;
    labelMic();
    maxInputChars = created.max_input_chars ?? maxInputChars;
    input.maxLength = maxInputChars;
    applyBranding(created.branding);
    if (created.locale && created.locale !== strings.__locale) await loadLocale(created.locale);

    // The wording recorded as evidence is the wording shown, so the tenant's
    // per-locale override wins over the bundle's default.
    consentWording = created.consent_wording ?? strings.consentWording ?? '';

    if (created.privacy_policy_url) {
      const link = document.getElementById('privacy-link');
      link.href = created.privacy_policy_url;
      link.textContent = strings.privacyLink ?? 'Privacy notice';
      link.hidden = false;
    }

    if (!hostConsent) {
      // Asked once. A refusal is stored and honoured, and we do not ask again.
      document.getElementById('consent-wording').textContent = consentWording;
      consentBar.hidden = false;
    }
  }

  async function recordConsent(granted) {
    consentBar.hidden = true;
    await call(`/v1/sessions/${sessionId}/consent`, {
      purpose: 'IDENTITY_RESOLUTION', granted, wording: consentWording,
    });
    append('system', granted ? (strings.consentAccepted ?? '') : (strings.consentRefused ?? ''));
  }

  document.getElementById('consent-yes').addEventListener('click', () => recordConsent(true));
  document.getElementById('consent-no').addEventListener('click', () => recordConsent(false));

  document.getElementById('forget').addEventListener('click', async () => {
    if (!sessionId) return;
    try {
      await call(`/v1/sessions/${sessionId}/forget`, {});
    } catch { /* the visitor's copy is cleared either way */ }
    forgetStored();
    sessionId = null;
    log.replaceChildren();
    append('system', strings.forgotten ?? '');
    composer.hidden = true;
  });

  // --- the spoken assistant ------------------------------------------------
  //
  // Three rules, and the order of them is the design:
  //
  //   1. Nothing is captured until the visitor presses the microphone. There
  //      is no always-on listening, no wake word and no permission asked on
  //      page load. The browser's own permission prompt is the second gate
  //      and the visitor's press is the first.
  //   2. The voice disclosure is spoken, in full, before the microphone is
  //      armed. Not alongside it, not after the first answer. A visitor who
  //      has put their microphone on has stopped reading the screen, and a
  //      disclosure they cannot hear is not one.
  //   3. Typing never goes away. The composer stays live the whole time, so
  //      the text route is an equal route and not a fallback for people the
  //      speech recogniser cannot understand, which, for a great many
  //      accents and speech differences, it cannot.
  //
  // Capture is the browser's own speech recogniser rather than audio streamed
  // to us. It keeps the visitor's raw voice on their own machine: what
  // crosses the network is the transcript, which is the same untrusted text
  // a typed message is, goes through the same pipeline, and is covered by the
  // same retention rule. It also means no microphone audio to store, which is
  // the easiest personal data to be holding by accident.

  const micButton = document.getElementById('mic');
  const voiceState = document.getElementById('voice-state');
  const SpeechRecogniser = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  let recogniser = null;
  let listening = false;
  let player = null;

  /** Labels that are not visible text still come from the bundle (UX-6). */
  function labelMic() {
    micButton.setAttribute('aria-label', strings.voiceSpeak ?? 'Speak to the assistant');
  }

  function sayState(text) {
    voiceState.textContent = text ?? '';
    voiceState.hidden = !text;
  }

  /**
   * Play one utterance and resolve when it has finished.
   *
   * Resolves rather than rejects on a playback failure: the words are already
   * on screen, and a browser that declines to autoplay must not leave the
   * conversation stuck waiting for audio that will never arrive.
   */
  function play(base64, mediaType) {
    return new Promise((resolve) => {
      if (!base64) { resolve(); return; }
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: mediaType ?? 'audio/mpeg' }));
        player?.pause();
        player = new Audio(url);
        const done = () => { URL.revokeObjectURL(url); speaking = false; resolve(); };
        player.addEventListener('ended', done, { once: true });
        player.addEventListener('error', done, { once: true });
        speaking = true;
        player.play().catch(done);
      } catch { speaking = false; resolve(); }
    });
  }

  /** Stop mid-sentence. The visitor speaking is always the more important. */
  function stopSpeaking() {
    if (player && !player.paused) player.pause();
    speaking = false;
  }

  function startListening() {
    if (!SpeechRecogniser || listening) return;
    recogniser = new SpeechRecogniser();
    recogniser.lang = strings.__locale ?? requestedLocale;
    recogniser.interimResults = false;
    recogniser.continuous = true;

    recogniser.addEventListener('result', async (event) => {
      const said = Array.from(event.results)
        .slice(event.resultIndex)
        .map((one) => one[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (!said) return;
      // Barge-in: the visitor talking over the assistant stops the assistant.
      stopSpeaking();
      sayState(strings.voiceThinking ?? 'Thinking…');
      await submit(said);
      sayState(listening ? (strings.voiceListening ?? 'Listening. Press the microphone to stop.') : '');
    });

    recogniser.addEventListener('error', (event) => {
      // "not-allowed" is a refused permission and is the visitor's decision,
      // so it is stated once and the microphone goes back off rather than
      // being offered again on a loop.
      stopListening();
      sayState(event.error === 'not-allowed'
        ? (strings.voiceRefused ?? 'The microphone is blocked. You can carry on by typing.')
        : (strings.voiceUnavailable ?? 'Speech input stopped. You can carry on by typing.'));
    });

    recogniser.addEventListener('end', () => {
      // Chrome ends a continuous session on its own after a silence. Restart
      // it while the visitor still has the microphone on, or the button says
      // it is listening when nothing is.
      if (listening) { try { recogniser.start(); } catch { /* already going */ } }
    });

    try {
      recogniser.start();
      listening = true;
      micButton.setAttribute('aria-pressed', 'true');
      sayState(strings.voiceListening ?? 'Listening. Press the microphone to stop.');
    } catch {
      sayState(strings.voiceUnavailable ?? 'Speech input is not available in this browser. You can carry on by typing.');
    }
  }

  function stopListening() {
    listening = false;
    micButton.setAttribute('aria-pressed', 'false');
    try { recogniser?.stop(); } catch { /* already stopped */ }
    recogniser = null;
  }

  micButton.addEventListener('click', async () => {
    if (listening) {
      stopListening();
      stopSpeaking();
      sayState('');
      return;
    }
    if (!SpeechRecogniser) {
      sayState(strings.voiceUnavailable ?? 'Speech input is not available in this browser. You can carry on by typing.');
      return;
    }
    micButton.disabled = true;
    try {
      // Rule 2. The switch returns the voice disclosure and its audio, and
      // the microphone is not armed until the audio has finished playing.
      const switched = await call(`/v1/sessions/${sessionId}/modality`, { modality: 'voice' });
      if (switched.disclosure) {
        document.getElementById('disclosure').textContent = switched.disclosure;
        sayState(strings.voiceDisclosing ?? 'Telling you what you are speaking to…');
        await play(switched.audio, switched.audio_media_type);
      }
      startListening();
    } catch {
      sayState(strings.voiceUnavailable ?? 'The spoken assistant is not available. You can carry on by typing.');
    } finally {
      micButton.disabled = false;
    }
  });

  // --- sending -------------------------------------------------------------

  /** One turn. Returns true on success; leaves a retry control on failure. */
  async function submit(text, options = {}) {
    if (!sessionId) return false;
    const bubble = options.silent ? undefined : append('visitor', text);
    const typing = showTyping();
    send.disabled = true;

    try {
      // Streaming and speaking are exclusive, and speaking wins on a voice
      // session. Sentence-at-a-time exists so a reader sees progress; a
      // listener gets no such benefit from audio that arrives in fragments,
      // and the synthesised reply comes with the whole-turn response.
      if (streamingAvailable && !listening) {
        await streamTurn(text, typing);
      } else {
        const reply = await call(`/v1/sessions/${sessionId}/messages`, { text });
        clearTyping();
        append('assistant', reply.text);
        renderNextAction(reply.next_action);
        // The text is on screen before the audio plays, and stays there if it
        // never does. A reply that was spoken and not written would be
        // unreadable to half the people this panel has to serve.
        if (reply.audio) await play(reply.audio, reply.audio_media_type);
      }
      return true;
    } catch (error) {
      clearTyping();
      // Degrade, never fail. The visitor is told the truth, offered a route on,
      // and, the audit's UX-10, offered their own text back rather than
      // losing it.
      append('system', error?.payload?.message ?? strings.errorGeneric ?? 'Something went wrong.');
      if (bubble) {
        bubble.classList.add('failed');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'retry';
        retry.textContent = strings.retry ?? 'Try again';
        retry.addEventListener('click', async () => {
          retry.remove();
          bubble.classList.remove('failed');
          await submit(text, { silent: true });
        });
        bubble.append(retry);
      }
      return false;
    } finally {
      send.disabled = false;
      input.focus();
    }
  }

  /**
   * Streamed turn (UX-2).
   *
   * Sentences arrive validated; the panel renders them as they land. Falls back
   * to the whole-turn endpoint on any transport problem, because a streaming
   * failure must never cost the visitor their answer.
   */
  async function streamTurn(text, typing) {
    const response = await fetch(`${api}/v1/sessions/${sessionId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ text }),
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload.message ?? 'stream failed');
      error.payload = payload;
      throw error;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let bubble;

    const handle = (event, data) => {
      if (event === 'sentence') {
        clearTyping();
        if (!bubble) bubble = append('assistant', data.text);
        else bubble.firstChild.textContent += ` ${data.text}`;
        log.scrollTop = log.scrollHeight;
      } else if (event === 'done') {
        clearTyping();
        if (!bubble && data.text) append('assistant', data.text);
        renderNextAction(data.next_action);
      } else if (event === 'error') {
        clearTyping();
        append('system', data.message ?? strings.errorGeneric ?? '');
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventLine = frame.split('\n').find((line) => line.startsWith('event: '));
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
        if (eventLine && dataLine) {
          try { handle(eventLine.slice(7).trim(), JSON.parse(dataLine.slice(6))); } catch { /* ignore a malformed frame */ }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    void typing;
  }

  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !sessionId) return;
    input.value = '';
    await submit(text);
  });

  // --- close, focus and the host handshake (UX-1) --------------------------

  function close() {
    // The launcher owns the frame, so closing is a message to it. It removes
    // the panel and returns focus to the launcher button.
    parent.postMessage({ source: 'detent-assistant', type: 'close' }, '*');
  }

  document.getElementById('close').addEventListener('click', close);
  // Escape is handled *in here*, where the visitor's focus actually is. Bound on
  // the host document it never fired, because this is a cross-origin iframe.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });

  // --- mobile keyboard (UX-5) ----------------------------------------------
  //
  // On iOS the layout viewport does not shrink when the keyboard appears, so a
  // 100vh panel puts the composer underneath it. The visual viewport does
  // shrink, so the body height follows it.
  function fitViewport() {
    const height = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--panel-height', `${height}px`);
    log.scrollTop = log.scrollHeight;
  }
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', fitViewport);
  window.addEventListener('resize', fitViewport);
  fitViewport();

  // Focus the heading on open so a screen-reader user lands at the top of the
  // dialog rather than wherever the browser decides.
  title.focus({ preventScroll: true });

  open().catch(() => append('system', strings.errorUnavailable ?? 'The assistant is unavailable right now.'));
