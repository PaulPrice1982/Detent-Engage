# Detent Engage: end-to-end demonstration

**Audience:** CRO, CFO, COO, CIO, in one room.
**Running time:** about eleven minutes of narration across thirteen scenes.
**Every screen is a photograph of the running build.** Nothing here is a mockup,
a wireframe or a rendering. What is not real is named as not real, in the scene
where it appears and again in section 14.

## The single reaction each seat must have

| Seat | The unspoken problem | What must land |
|---|---|---|
| CRO | "We lose deals in the gap between the website and the CRM, and I cannot see the gap." | Qualification happens at the point of enquiry, with the reason attached. |
| CFO | "I cannot tell you what our contracts entitle us to, or what we have given away." | Contract terms, notice deadlines, uplift and spend are first-class data, and nobody moves money alone. |
| COO | "Every new tool is a six-month programme with a consultant attached." | An account and a contract in one form; the assistant live in one script tag. |
| CIO | "Another AI vendor wants our customer data and cannot tell me what it does with it." | Consent before identification, disclosure every session, one tenant per row, a hash-chained record of every act. |

---

## Scene 1 — The claim (0:00, 40s)

**On screen:** `01-marketing-home.png`

> Every company in this room has a website that takes enquiries, and a CRM that
> takes records, and between them a gap that nobody owns. A visitor arrives at
> two in the morning with a real problem and a real budget, types it into a box,
> and what happens next is a form submission, a queue, and a reply eleven hours
> later to someone who has already spoken to your competitor.
>
> The usual answer is a chatbot. The reason you have not bought one is that a
> chatbot will say anything. It will invent a price, promise a delivery date,
> and enrol the visitor in a marketing sequence they never agreed to, and the
> first you hear of it is from your DPO.
>
> Detent Engage is the other thing. It is an assistant that is not allowed to
> lie, cannot act without consent, and writes down everything it does.

---

## Scene 2 — Setting up an account (0:40, 75s)

**On screen:** `08-console-new-account.png`

> This is how a customer is set up. One form.
>
> Look at what it asks for, because this is the part every other revenue tool
> leaves out. Term: thirty-six months. Start date. Notice period: a hundred and
> eighty days. Renewal uplift: four and a half per cent. Monthly credits. A
> spend cap. Seats, conversations, voice minutes.
>
> Most systems capture the price and throw the contract away. The contract goes
> into a PDF, the PDF goes into a folder, and eighteen months later nobody can
> tell you when the notice window closes. Detent captures the commercial terms
> at the moment the account is created, because everything downstream, renewal,
> uplift, entitlement, the right to charge for overuse, is derived from them.
>
> One form, and the customer exists with their contract attached.

## Scene 3 — What that gives you (1:55, 70s)

**On screen:** `13-console-account-contract.png`

> Here is Northwind Logistics a moment later.
>
> Term, thirty-six months. Renews on the first of January 2029. **Notice
> deadline: the fifth of July 2028, open.** That date is not in the contract.
> It is derived from the contract: renewal date minus a hundred and eighty
> days. It is the date on which this revenue becomes at risk, and it is
> calculated, dated and shown without anybody remembering to work it out.
>
> Renewal uplift, four and a half per cent, sitting next to it. Spend cap,
> fifteen thousand pounds. Limits per period, with voice minutes and
> conversations metered against them.
>
> CFO: this is the answer to "what are we entitled to charge, and when do we
> lose the right to ask". Not a report you commission. A field on a screen.

## Scene 4 — Pricing that does not break the base (3:05, 55s)

**On screen:** `26-support-forbidden.png`

> Packaging, in the back office rather than in a deploy.
>
> Read the line at the top: *changing a price here never changes what an
> existing customer pays.* Every subscription is pinned to the version it was
> sold on and the fee it was contracted at. A customer moves only by a
> deliberate plan change, or at renewal with an agreed uplift.
>
> Anyone who has repriced a SaaS base knows why that sentence matters. Editing
> a price list and silently repricing four hundred live contracts is a way to
> lose a year.
>
> Note also what the plan charges for: not seats, not messages, but a confirmed
> outcome. A booked meeting or a qualified handover.

---

## Scene 5 — Installation (4:00, 45s)

**On screen:** `24-install-guide.png`

> Installation is one script tag.
>
> That is the whole integration for the visitor-facing assistant. No tag
> manager project, no CDP, no data layer. The tenant's own knowledge is
> uploaded separately and the assistant answers only from it.
>
> COO: the question you are asking is how long before this is doing something.
> The answer is that setting up the account is the long part, and it is a form.

## Scene 6 — A visitor arrives (4:45, 90s)

**On screen:** `21-widget-open.png`, then `22-widget-turn-1.png` through `22-widget-turn-5.png`

> A visitor opens the panel. Before a single question, a disclosure: *you are
> chatting with an AI assistant, not a person.* Every session. Not a footnote,
> not a tooltip.
>
> He says he runs forty vans out of two Midlands depots, and his telematics
> contract ends in March.
>
> Watch the assistant qualify. Scale. Requirement. Then this:
>
> *"Then the decision has to be made before the notice window closes, not
> before the contract ends. That is usually the date that catches people out."*
>
> That is not small talk. That is the single most valuable sentence in the
> conversation, and it is the same insight the back office calculates for your
> own contracts, pointed at the prospect's.
>
> Then authority. Then, and only then, the email address, because it asks for
> contact details after it has given something worth having.
>
> And at the end: *"Nothing else will be sent to you, and you have not been
> added to any marketing list."*

## Scene 7 — Consent, not capture (6:15, 55s)

**On screen:** `22-widget-turn-5.png` (lower third), `20-widget-open-mobile.png`

> Underneath the conversation, the thing your CIO is looking for.
>
> *"May we check whether we already know you, so we can put you through to the
> right person?"* With a "what does this mean" explanation, a yes, a no, and a
> "forget me".
>
> Identity resolution does not begin until that is answered. Not degraded, not
> deferred: refused. The assistant is told what it may do with a record; it is
> never given the record. And on a phone it is the same panel and the same
> gate.

## Scene 8 — The outcome (7:10, 60s)

**On screen:** `json/outcome-ledger.json`, `json/analytics.json`

> The conversation produced one thing that matters: an outcome.
>
> `book_meeting`, state CONFIRMED, billable true, with an **evidence URL**. That
> link replays the exact conversation that produced it.
>
> CRO: this is the difference between "the chatbot had four hundred
> conversations" and "here is the meeting, here is why it qualified, here is
> the transcript". The funnel underneath counts sessions, engaged, qualified,
> outcomes, meetings held, and how many arrived outside business hours.
>
> That last number is the honest one. It is the pipeline you were not going to
> get.

---

## Scene 9 — Nobody moves money alone (8:10, 80s)

**On screen:** `12-console-approvals.png`, then `28-approvals-after-approval.png`, then `29-account-after-approval.png`

> Two actions waiting. Two thousand five hundred pounds of promotional credit,
> and a spend cap going from five and a half to nine thousand. Each with the
> person who asked, the amount, and **the reason in their own words.**
>
> Neither has happened. Above a threshold no single person acts, whatever their
> role. An administrator is not a superuser here: they are the person most
> worth compromising.
>
> A second person approves. The queue drops to one, and the credit appears on
> the account.
>
> CFO: you cannot approve your own request, and you cannot approve an action
> you would not be permitted to take yourself. The threshold is five hundred
> pounds for a credit, two hundred and fifty for a refund, five thousand for a
> spend cap, and a plan override always needs two people whatever it is worth.

## Scene 10 — Who can do what (9:30, 70s)

**On screen:** `25-support-cannot-move-money.png`, `27-viewer-console.png`

> The same account, seen by the support team.
>
> They can see everything: the contract, the balance, what is overdue. Every
> money action is greyed. Hold dunning is not, because pausing a chase only
> ever helps a customer.
>
> And the pending approval shows *"Needs credit.grant"* instead of an Approve
> button, with the reason on it, because an operator who cannot see a control
> assumes the system is broken and asks a colleague to do it for them, which is
> exactly the behaviour dual control exists to prevent.
>
> Two more things a CIO will ask. First: the greyed button is not the control.
> The endpoint behind it refuses the same request. Second: no role can move
> money at all until that person has enrolled a second factor. Not the billing
> team, not the administrator, not the owner. A password is one phishing email
> away from a refund to somebody else's card.
>
> And the owner role, which manages people, deliberately cannot move money,
> because whoever can add a user must not also be able to pay themselves.

## Scene 11 — Voice, and what is actually built (10:40, 45s)

**On screen:** `json/session-text.json` and `json/session-voice.json` side by side

> A word on voice, and I am going to be precise about this.
>
> Open a session in voice modality and the disclosure changes: *"you are
> **speaking** with an AI assistant"*, in spoken form. Voice minutes are metered
> against the contract, concurrent calls are capped, and there is always a
> text-only route out of the voice channel.
>
> The governance is live. The speech channel itself is built as a separate
> component and is not yet connected to the server, and there is a guard in it
> that refuses to open a session in which the speech provider is allowed to
> answer on its own: every spoken word has to come through the same governed
> pipeline as every typed one.
>
> So: the controls came first, the microphone comes next. The voice you are
> listening to now is the narrator, not the product.

## Scene 12 — The record (11:25, 70s)

**On screen:** `json/audit.json`, `json/compliance.json`

> Everything you have just seen, in one chain.
>
> Session opened. Disclosure shown. Tool executed. Outcome recorded. Credit
> requested. Approved, by a named second person. Executed. Granted.
>
> Each entry carries the hash of the one before it. Remove an entry, change an
> amount, and every hash after it stops matching. This is not a log file that
> somebody could edit; it is a chain that says whether it has been edited.
>
> And the compliance view: AI disclosure coverage, one hundred per cent.
> Identity resolutions blocked for consent. Marketing enrolments blocked. CRM
> disclosure denials. Those are not aspirations. They are counters.
>
> CIO: when your regulator, your insurer or your largest customer's procurement
> team asks what your AI did, this is the answer, and it is generated, not
> written.

## Scene 13 — Who touches it (12:35, 80s)

**On screen:** persona table (below)

> Seven people interact with this, and each sees only their own surface.

| Persona | Surface | What they do | What they cannot do |
|---|---|---|---|
| **Visitor** | The panel on the customer's site | Ask, consent or refuse, book, be forgotten | Be identified before they consent; be enrolled in marketing |
| **Customer owner** (Dan Harper, Northwind) | Detent Manage | See plan, usage, renewal, notice, credit; install; upload knowledge | See another tenant; see Detent's back office |
| **Customer member** (Joy Okafor) | Detent Manage | Day-to-day use within the tenant | Billing and contract changes |
| **Detent support** (Saada Ibrahim) | Back office | See any account, pause a chase | Move money; approve |
| **Detent billing** (Marcus Whitlock) | Back office | Credits, invoices, payments, refunds, onboard a customer | Change a spend cap, override a plan, manage users |
| **Detent commercial** (Grace Aldridge) | Back office | Plan overrides, spend caps, write-offs, approvals | Manage users |
| **Detent owner** (operations) | Back office | Manage people and roles, approve | **Move money** — deliberately |
| **Reseller** | Partner portal | Their own book, their own commission | Any customer that is not theirs |

> The separations are the point. The person who opens a supplier account is not
> the person who pays it, and that principle is wired into the roles rather
> than written in a policy nobody reads.

## Scene 14 — What is true, and what is next (13:55, 60s)

**On screen:** `03-trust.png`, `04-assurance.png`

> I will end where a demonstration usually does not, which is with the gaps.
>
> Live and verified: the governance pipeline, consent, disclosure, the outcome
> ledger, contract terms and notice calculation, dual control, role and
> multi-factor gating, the hash-chained audit, one tenant per row enforced by
> the database rather than by the application, and no card number anywhere in
> the platform.
>
> Not yet: the speech channel is not connected. The platform's own audit chain
> and spend counters run in memory until the durable adapters are wired, which
> is the last piece before a pilot. There is no screen for managing console
> users, so roles are set by an administrator. And the assistant's wording in
> this recording came from a deterministic script, not from a model, because
> this build was recorded without a model key: the governance you saw is real,
> the phrasing is fixed.
>
> Everything on that second list is scheduled. Everything on the first list you
> have just watched happen.

---

## Production notes

- Screens live in `docs/demo/shots/`, API evidence in `docs/demo/json/`.
- Reproduce with `AWA_DEMO_SEED=1` and a `DATABASE_URL`, then the capture
  script in `docs/demo/capture/`. The seed is refused in a deployment.
- Narration by ElevenLabs. The narrator is not the product; see scene 11.
