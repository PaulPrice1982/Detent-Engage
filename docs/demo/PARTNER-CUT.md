# Detent Engage: the partner cut

**Audience:** the owner of a web agency or IT reseller who already builds and
hosts client websites.
**Running time:** 2 minutes 12.
**Files:** `detent-engage-reseller.mp4`, and
`detent-engage-reseller-vertical.mp4` for a feed.
**Manifest:** `reseller.json`. **Narration:** `audio/reseller.mp3`.

## The single reaction it must provoke

> *I already have the client list. I have been giving away the only part that
> keeps paying.*

An agency owner's unspoken problem is not lead generation and it is not AI.
It is that a website is a project, a project ends, and every January the
revenue starts from zero. The film is built on that and nothing else.

## Why no commission rate is stated

Deliberately, and this is the one editorial rule in the cut.

The film says the partner earns *a margin on what the client spends, for as
long as that client is paying and the partner is in the programme*. It never
says what the margin is, because **the two published answers do not agree**:

| Source | What it says |
|---|---|
| The marketing site's `partners.html` | Two tiers. Certified and Strategic. A flat rate each, from the first client, on everything the client pays, for the life of the customer. Minimum two new clients a month to retain status. |
| `packages/reseller/src/bands.ts` | Four bands — Registered, Silver, Gold, Principal — rising with annualised book value, the rate applying to the whole period's revenue once a band is reached. No minimum. |

Those are different programmes, not different wordings of one programme. A
partner who reads the page and is paid by the code is paid the wrong amount,
and the difference is recoverable from us, not from them. **Settle the model,
then reconcile the page, the code and the partner agreement — before this
film is shown to anyone who could sign.** Until then the film states the
shape of the deal, which is true under either answer.

The three things the film does assert about the money, all true under both:

1. Detent contracts with the client, invoices the client and runs the
   platform. The partner installs and looks after the relationship.
2. The margin is on the client's own spend, monthly or annual, whichever way
   they buy — not a one-off introduction fee.
3. It runs for as long as the customer is paying and the partner is in the
   programme, which is what makes the tenth install still pay in year three.

## The narration

> You build the website. You host it. And you get the call when the contact
> form stops working.
>
> Here is the part nobody says out loud. A website is a project, and a project
> ends. The day it goes live, it stops earning. For your client, and for you.
>
> This is Detent Engage. One script tag, on a site you already maintain.
>
> It is not a chatbot. A chatbot answers a question and drops a calendar link.
> This one qualifies the visitor, prices inside the authority your client gave
> it, refuses what it has no authority to give, and books the meeting with a
> named person.
>
> It answers only from knowledge your client approved. When it does not know,
> it says so, and hands the visitor to a human. It tells every visitor it is
> AI before anything else happens. And it will not try to work out who someone
> is until they have said yes.
>
> It does all of that out loud, too. A visitor presses the microphone and
> talks to it, and it answers in its own voice, having told them what it is
> first. Typed or spoken, it is the same governed answer.
>
> Which means you can put this on a client's site without inheriting their
> risk.
>
> Now the part that changes your business.
>
> You install it, and you look after the client. We contract with them, we
> invoice them, and we run the platform. You earn a margin on what that client
> spends with us. Monthly or annually, whichever way they buy.
>
> Not a referral fee. Not a one-off payment for the introduction. A margin on
> their spend, for as long as they are a paying customer and you are a partner
> in the programme.
>
> So the tenth site you install is still paying you in year three, while you
> are installing the fortieth.
>
> You already have the client list. You already have the relationship. You
> already get the call.
>
> This is the first thing you can sell them that does not stop earning.
>
> Detent Engage. Partner programme.

## Every caption is checked against the frame under it

The five conversation beats run in clip order and each lower third describes
what is visibly on screen at that moment. This matters more than it sounds: a
first cut carried the caption *"when it cannot answer, it says so and hands
over to a person"* over a frame in which the assistant answers confidently.
The claim is true of the product — `packages/billing/src/reply-billing.ts`
does not charge for a reply that could not answer — but it was not true of
that picture, and a partner watching a caption that does not match the screen
stops believing the other captions too. The narration may describe the
product; a lower third may only describe its own frame.

## What is not in this cut, and could be

The reseller portal. It exists — `packages/server/src/reseller-pages.ts`
serves Overview, Statements and Customers, with commission earned, commission
pending, the band, collected spend and the note that VAT belongs to HMRC and
is not commissionable. Filming it needs a seeded reseller with linked
accounts and raised invoices, which the demonstration seed does not create.
It is the strongest possible scene for this audience and it is the obvious
next addition.

## Rebuilding it

```sh
cd docs/demo/capture && npm install
node cards.cjs   ../reseller.json   # cards and lower thirds -> frames/reseller
node promo.mjs   reseller.json      # the cut, and the vertical
```

Both scripts take the manifest as their one argument, so the promotional cut
and the partner cut are two manifests rather than two copies of a script.
