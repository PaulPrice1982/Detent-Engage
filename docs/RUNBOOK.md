# Detent Engage: the runbook

**For Tony and Tom.** One front door. Everything else in `docs/` is reference
you are routed to from here, not reading you do up front.

Read sections 1 to 3 before you touch anything. That is about twenty minutes
and it will save you a day.

---

## 1. What the product is, in one page

A visitor lands on **a customer's** website. A panel offers to help. The
visitor types a question. An AI assistant answers it, qualifies them, and
either books a meeting, hands them to a person, or decides they are not a
fit.

**How Detent charges for that, stated carefully, because it is easy to get
wrong and somebody already has.** The customer buys a **monthly or annual
subscription** that includes a credit balance, and their replies, voice
minutes, conversations and enrichment draw against it. On top of that, most
plans carry a **fee per confirmed outcome** — `starter` £6, `growth` £5,
`command` £4 — and `answers`, the self-serve plan with no CRM to confirm an
outcome in, charges 50p per assistant reply instead, capped at six billable
replies a conversation so a conversation cannot exceed £3 however long
somebody talks. A reply the assistant could not answer from approved
knowledge is not charged at all.

"We charge for the outcome, not for messages" is a good line and it is not
the whole model. The subscription is the base; the outcome fee is one line
item on it. `packages/billing/src/plans.ts` is the truth.

The thing that makes it sellable is not the assistant. It is everything
around the assistant:

- It **discloses** that it is AI, on every single session, before the first
  question.
- It **cannot identify** a visitor until they say yes to being identified.
  Not degraded, not deferred. Refused.
- It **answers only from the customer's own uploaded knowledge**. It cannot
  invent a price, a date or a capability.
- Every tool it wants to call goes through a **gate** that decides whether
  the platform permits it. The model proposes; the platform disposes.
- Everything it does lands in a **hash-chained audit log**, per tenant.

When somebody asks you what Detent Engage is, that is the answer. The
assistant is the demo; the governance is the product.

### What this is not

**Detent Engage is not Detent Recover.** Recover is a separate offering:
contract monetisation, excess-use recovery, renewal and notice windows. Do
not mix them in a conversation, a deck or a demo. If a prospect asks about
recovering revenue from their contract data, that is a Recover conversation
and it is Paul's.

---

## 2. What is built, and what is not

Do not take this from the marketing site. Take it from here.

### Built, tested, and demonstrated

| | Where it lives |
|---|---|
| The visitor panel, text modality | `packages/widget` |
| Disclosure on every session, text and voice wording | `packages/agent` |
| The consent gate before identity resolution | `packages/agent`, `packages/context` |
| Grounded answers from the tenant's own knowledge | `packages/knowledge` |
| The tool gate and the nine outcome types | `packages/agent`, `packages/core` |
| The outcome ledger with replayable evidence | `packages/core` |
| Per-tenant hash-chained audit | `packages/audit` |
| Row-level security, one tenant per row, in Postgres | `db/migrations/0005_platform_rls.sql` |
| The back office: accounts, subscriptions, credits, approvals | `packages/console`, `packages/billing` |
| Dual control over money, role and MFA gating | `packages/console/src/rbac.ts` |
| The customer area: install, knowledge, billing, status | `packages/server/src/app-*.ts` |
| The reseller portal and commission | `packages/reseller` |
| The spoken assistant, end to end | `packages/voice`, `packages/widget/public/panel.js` |

**On voice specifically**, because this section used to say the opposite and
you may have been told it. It is wired. A visitor presses the microphone,
the panel switches the session to voice modality, the tenant's spoken
disclosure is played **before** capture is armed, the transcript goes through
the same governed pipeline as a typed message, the reply comes back as text
and audio, and the voice minute is metered from the duration that actually
played. `tests/voice-wiring.test.ts` is the gate.

Two things about it are worth knowing before you change anything.

`assertApprovedForSpeech` and `Platform.speakApproved` are the whole safety
argument: the synthesiser is handed text that has already been through the
pipeline and is given no history, no question and no tools. The `approved`
parameter looks redundant. It is not. Leave it.

Capture is the **browser's own** speech recogniser, so the visitor's audio
stays on their machine and what crosses the network is a transcript. That
means no microphone audio for us to store, and it means Chrome. Firefox and
Safari do not implement it, and the panel correctly hides the microphone
there rather than offering one that does nothing.

### Built but not connected

`packages/voice`'s **realtime** half. `GovernedVoiceSession` and the OpenAI
Realtime adapter are for a live bidirectional session — telephony, or
streaming audio — and this server holds no sockets open. What is wired is
the turn-shaped surface beside it. If you want a phone channel, that is the
piece to connect, and the guard stays exactly where it is.

### Not built

- **No screen for managing console users.** Roles are set by an
  administrator against the database. See `docs/ACCESS-HANDOVER.md`.
- **The Platform core still runs in memory** even with `DATABASE_URL` set:
  the audit chain, consent events and spend counters are lost on restart.
  Sessions and the back office are durable; that core is not. **This is the
  last thing to fix before a pilot** and it is the single largest risk on
  the board.
- **API keys are in memory** and are lost on restart.
- **OIDC sign-in buttons render and dead-end.**
- No penetration test, no accessibility audit.

---

## 3. Getting it running

### On your machine

```sh
pnpm install            # never with --no-optional; it breaks esbuild's binary
pnpm typecheck          # two lines of output, then nothing
pnpm test               # 1,254 passed, 3 skipped
pnpm serve
```

The three skipped tests need a PostgreSQL and a Redis and skip themselves
without one. That is correct, not a failure.

**The suite runs under three runners** — vitest, the built-in runner under
tsx, and the built-in runner on Node alone — and all three must agree. If you
change a test, run all three. `tools/test.mjs` picks whichever is installed.

### On Replit

`REPLIT-PROMPT.md` in the repository root is written for the Agent, and it is
written to cost as few Agent requests as possible. **The Shell is free and the
Agent is not.** Read the first page of that file before you paste anything.

Two secrets are required and neither is in the repository:

| Secret | What |
|---|---|
| `DETENT_CONSOLE_PASSWORD` | The first operator's password, 12 characters or more |
| `DETENT_SESSION_SECRET` | 32 characters or more; `node tools/make-secret.mjs session` |

Without `DETENT_SESSION_SECRET` everybody is signed out at the next restart,
and the boot banner will tell you so in plain words. Read the banner. It
reports what is actually wired rather than what the deployment claims.

### Things that will bite you

These are not opinions. Each one cost a day.

1. **Never `pnpm install --no-optional`.** It breaks esbuild's platform
   binary, tsx stops working, and the failure looks like a broken repository.
2. **The server binds `0.0.0.0`.** A loopback bind leaves a perfectly healthy
   process that the preview proxy reports as "running, but the preview isn't
   ready". Do not change it.
3. **`SET LOCAL app.tenant_id`, never a plain `SET`.** A plain `SET` survives
   the transaction back into the pooled connection and becomes the next
   request's tenant context. That is a cross-tenant data leak.
4. **The platform never holds a card number.** PSP token references only.
   `assertNoCardData` will throw if you try.
5. **One test file per CI gate.** A test is changed only when the test is
   wrong, and you state the reason in the commit.
6. **Curl cannot see a Content Security Policy.** Every server-rendered page
   shipped unstyled in every browser for weeks because the suite asserted on
   HTML and the HTML was right. When you change a page, open it in a browser.

---

## 4. What the customer does to implement

This is the part you will be asked about on every call. It is four steps and
the longest one is a form.

### Step 1 — the account exists

Detent creates it in the back office at `/console/new`: organisation name,
tenant id, billing email, plan, and the entitlement (seats, conversations,
voice minutes). One form, and the customer and their subscription are created
together. An account can never sit in the system without commercial terms
against it.

The customer receives a sign-in for **Detent Manage** at `/app`.

### Step 2 — one script tag

The customer signs in and goes to **Install**. The page shows their own
snippet with their own key already in it:

```html
<script
  type="module"
  src="https://…/widget/loader.js"
  data-detent-assistant
  data-api="https://…"
  data-key="awa_pub_…"
  data-panel="https://…/widget/panel.html"
  data-org="Their Company"
  data-label="Ask a question"
  data-jurisdiction="UK"
  defer></script>
```

It goes before the closing `</body>` on every page they want the assistant
on. **Answer these two questions before they ask them:**

- *"Is that key safe in our page?"* Yes, by design. It identifies the tenant
  and can only open a conversation. It cannot read their CRM, their knowledge
  or their billing. The private keys are never in a web page.
- *"Will it break our site's CSS?"* No. It injects a Web Component with its
  own Shadow DOM, so it can neither inherit nor disturb their styles, and the
  conversation bundle only loads when somebody opens the panel.

Branding is attributes on the same tag: `data-logo`, `data-accent`. The
assistant carries their brand, not ours.

### Step 3 — the knowledge

**Detent Knowledge** at `/app/knowledge`. They upload their documentation;
the platform extracts candidate answers and puts them in *Awaiting your
review*. Nothing is published until the customer approves it, and the
assistant answers only from what is published.

This is the step that decides whether the assistant is any good. A customer
who uploads nothing gets an assistant that can only escalate. Say so early.

### Step 4 — watch it

**Overview** shows plan, usage and credit. **Status** shows whether the
service is healthy. **API** is there for the ones who want to pull outcomes
into their own systems.

Typical elapsed time: the account in minutes, the tag in an afternoon once it
is through their change process, the knowledge in a week of someone's
part-time attention.

---

## 5. Your first week

| Day | Do | Done when |
|---|---|---|
| 1 | Get it running locally. Read sections 1–3. | `pnpm test` green under all three runners, `pnpm serve` boots, you have signed in to `/console` and `/app`. |
| 2 | Deploy to Replit from `REPLIT-PROMPT.md`. | `/console/signin` renders **dark navy with a white card** in a browser. Not curl. |
| 3 | Walk the customer path end to end as a customer would. | You have installed the tag on a scratch page and had a conversation with your own assistant. |
| 4 | Read `docs/ARCHITECTURE.md` and `docs/OPERATIONS.md`. | You can say which package owns the consent gate without looking. |
| 5 | Wire the Platform core onto the Postgres adapters. | The boot banner stops printing the in-memory NOTE. |

After that: the console user-management screen, and the realtime voice
channel if a phone product is wanted.

---

## 6. Where everything else is

| Question | Document |
|---|---|
| Who has an account, what role, how do I grant access? | `docs/ACCESS-HANDOVER.md` |
| How is it put together? | `docs/ARCHITECTURE.md` |
| How do I run it in anger? | `docs/OPERATIONS.md` |
| What has to be true before a pilot? | `docs/GO-LIVE-CHECKLIST.md` |
| A customer's security team is asking. | `docs/SECURITY-QUESTIONNAIRE.md`, `docs/TRUST.md` |
| A customer's DPO is asking. | `docs/COMPLIANCE.md` |
| What did the audit find and what did we do? | `docs/AUDIT-RESPONSE.md` |
| What connects to what? | `docs/CONNECTORS.md` |
| How do I deploy? | `REPLIT-PROMPT.md` |
| How do I rebuild the demonstration? | `docs/demo/README.md` |

---

## 7. Escalation

**Anything that could move money, expose one tenant's data to another, or
weaken a control: stop and talk to Paul before you ship it.** Everything else
is yours.

The three that are never a judgement call:

- A test that fails is a bug until proven otherwise. Do not skip it to get
  green.
- A control that is inconvenient is still a control. The MFA gate on money
  and the dual-control threshold are not friction to be designed away.
- If a screen tells somebody something the system has not actually done,
  that is the most serious class of bug in this codebase. Every significant
  fault found so far has been exactly that.
