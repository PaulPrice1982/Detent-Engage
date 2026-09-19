# Detent Engage, access handover

Who can sign in, where, with what, and how an administrator grants or restores
access. Written for the person taking operational ownership of the deployment.

**Nothing in this document contains a password, and no password in this system
can be recovered by reading it.** Passwords are stored as scrypt hashes and
API keys as SHA-256 digests, so neither Detent nor anybody with database access
can tell you an existing secret. Every route back in is a reset, not a lookup,
and that is deliberate.

---

## 1. Active accounts and roles

There is **one** account that exists in a fresh deployment. Everything else is
created by a person using the product.

| # | Name or identifier | Realm | Role | Login URL | Authentication | Created by |
|---|---|---|---|---|---|---|
| 1 | Value of `DETENT_CONSOLE_EMAIL` (the founding operator) | `console` | `admin` + `owner` | `https://<console host>/console/signin` | Password (scrypt) + session cookie. TOTP required before any money action. | Seeded at boot from environment variables |
| 2 | Each partner's `contactEmail` | `reseller` | `reseller`, scoped to one `resellerId` | `https://<reseller host>/reseller/signin`, or `/reseller/signin` on the app host | Password (scrypt) + session cookie, set by the partner through the reset link | An operator, from the console reseller page |
| 3 | Each customer's own users | `app` | `owner` of their tenant | `https://<app host>/app/signin` | Password (scrypt) + session cookie | Customer self-signup at `/app/signup` |
| 4 | Widget key, per tenant | API | `widget` audience | `POST /v1/sessions` | Bearer key `awa_pub_…`, bound to the tenant's registered origins | Issued through the console or the keys endpoint |
| 5 | Server key, per tenant | API | `tenant_admin` audience | `/v1/*` | Bearer key `awa_sk_…` | Issued by a tenant admin or platform admin |
| 6 | Platform key | API | `platform_admin` audience | `/v1/*` | Bearer key `awa_sk_…` | Issued at boot; the only principal permitted across tenants |

Rows 2 and 3 are empty in a new deployment. Row 1 is the only account that
exists before anybody uses the product, and it is the one to hand over.

### Test accounts

**There are none, and none may be shared.** Every credential in the repository
lives in `tests/` and belongs to an in-process fixture that is constructed and
discarded inside a test run. They authenticate against nothing that is
deployed, reachable or persistent, so they are not withheld here for caution:
there is nothing for them to open.

The one seeded account (row 1) is a **real administrative account**, not a test
account, whatever it is called in a staging environment. Treat its password as
production credential material even in staging, because the same code path
creates it in both.

---

## 2. Console roles

Five roles, additive except `owner`. Nine capabilities that move money are
refused outright to anybody who has not enrolled in TOTP, whatever their role.

| Role | Can | Cannot |
|---|---|---|
| `viewer` | Read accounts, usage, invoices, payments, subscriptions | Everything else |
| `support` | Viewer, plus read the audit trail and place a dunning hold | Move money |
| `billing` | Support, plus issue and void invoices, grant and reverse credit, take and refund payments, change subscriptions, create accounts, manage resellers | Write off, override a plan, change a spend cap, manage users |
| `admin` | Billing, plus write-offs, plan overrides, spend caps, dunning suspension, the tenant kill switch, granting approvals | Manage users |
| `owner` | Read, audit, **manage console users and roles**, grant approvals | **Move money, by design** |

`owner` and `admin` are deliberately disjoint on the two things that matter: on
a staffed console, no one person can both grant themselves a capability and use
it. The founding operator holds both because there is nobody to separate them
from yet. **The day a second operator exists, split them.**

Money actions above a threshold need a second person regardless of role: credit
grant over £500, refund over £250, write-off over £500, spend cap change over
£5,000, and every plan override, kill switch and dunning suspension.

---

## 3. Authentication methods

| Method | Where | Detail |
|---|---|---|
| Password | All three sign-in pages | scrypt, N=16384 r=8 p=1, per-password salt, parameters stored with the hash and upgraded on next login. Minimum 12 characters, refused if it contains the person's own name, email or organisation. 8 consecutive failures locks the account for 15 minutes. Timing is equalised so an unknown address takes as long as a known one. |
| Session cookie | All three | Opaque server-side session, HMAC-signed, `HttpOnly`, `SameSite=Lax`, `Secure` and `__Host-` prefixed in a deployment. Console 8 hours absolute and 60 minutes idle; reseller 24 hours and 8 hours; customer app 14 days and 7 days. Revocable, because they are not JWTs. |
| CSRF token | Every form POST | Bound to the session, second control behind `SameSite`. |
| TOTP (authenticator app) | Console, before any money action | RFC 6238, 6 digits, 30-second step, one step of tolerance, each code accepted once. Ten single-use recovery codes, shown once at enrolment and stored hashed. |
| API keys | `/v1/*` | `awa_pub_…` for widgets, `awa_sk_…` for servers. Stored as SHA-256 digests; the secret is shown once at issue and never again. Widget keys are refused from any origin the tenant has not registered. |
| OIDC / SSO | Customer app only | **Implemented but not connected.** The buttons dead-end; no provider credentials are read from the environment. Treat SSO as unavailable until wired. |

---

## 4. Granting and restoring access

### The founding operator (row 1)

Set before first boot, and **rotatable at any time without database access**:

| Variable | Purpose |
|---|---|
| `DETENT_CONSOLE_EMAIL` | The operator's address. Use a real, monitored mailbox: the reset link goes there. |
| `DETENT_CONSOLE_PASSWORD` | The password. Read at every boot. |
| `DETENT_SESSION_SECRET` | Signs session cookies. At least 32 characters. If it changes, everybody is signed out. |

**To grant access to a named person:** set `DETENT_CONSOLE_EMAIL` to their
address, set `DETENT_CONSOLE_PASSWORD` to a strong value generated in your
password manager, and restart. Give them the password through the password
manager, never by email or chat, and have them change it and enrol in TOTP at
once.

**To restore access when the password is lost:** set `DETENT_CONSOLE_PASSWORD`
to a new value and restart. The account is matched by address and its password
replaced; nothing else about it changes. This is the documented recovery path
and needs no database access.

**To restore access when the authenticator is lost:** use one of the ten
recovery codes issued at enrolment. If those are gone too, another operator
holding `user.manage` disables MFA on the account. With only one operator and
no recovery codes, the remaining route is to clear the MFA fields on that row
in `auth_user` — record it as a break-glass action, and re-enrol immediately.

**If `DETENT_CONSOLE_PASSWORD` is not set,** no operator account is created.
The rest of the site still serves and the sign-in page says what to set. This
is deliberate: refusing to start would take the customer app down over a
setting the customer app does not need.

### A second console user

Sign in as the founding operator (who holds `owner`) and create them, then set
their role. Give a new operator exactly one of `admin` or `owner`, and remove
the other from the founding account, so the separation of duty becomes real.

> **Open gap, stated plainly.** The service layer has create, set roles,
> disable and end-all-sessions, and there is no console screen for any of them
> yet. Until that screen exists, a second console user has to be created
> through the service layer by an engineer. This is the highest-value remaining
> item and is listed in the summary as such.

### A reseller partner

Console → Resellers → the partner → **Create portal login**. This creates their
`reseller`-realm user with a random password nobody sees and sends them to the
reset flow. You never see or set a partner's password; that is the intended
design.

### A customer

Customers create their own accounts at `/app/signup`. Nobody at Detent sets a
customer password. To help a locked-out customer, direct them to
`/app/forgot`.

### Password reset (all three realms)

`/console/forgot`, `/app/forgot`, `/reseller/forgot`. A link valid for 45
minutes, single use, only its hash stored, 5 requests per address per hour,
identical response whether or not the address exists. Completing a reset ends
every session that user had.

**Email must be configured or reset links go nowhere useful.** Set
`DETENT_EMAIL_PROVIDER` (`resend` or `postmark`), `DETENT_EMAIL_API_KEY`,
`DETENT_EMAIL_FROM` and `DETENT_BASE_URL`. Without them the link is written to
the process log instead of sent, which both fails the user and puts a
credential into the log aggregator.

### Revoking access

| To do this | Do this |
|---|---|
| Disable a person | `UserService.setActive(userId, false)`. They cannot sign in and cannot self-restore by reset. |
| Sign somebody out everywhere | `SessionService.endAllFor(userId)`, or change their password, which does it too. |
| Revoke an API key | `DELETE /v1/tenants/<id>/keys?key_id=<id>`, or rotate with an overlap window from the console. |
| Stop a whole tenant | The `tenant.kill_switch` capability, platform admin only. |

---

## 5. What to do on day one

1. Set `DETENT_CONSOLE_EMAIL` to a real monitored mailbox and
   `DETENT_CONSOLE_PASSWORD` to a value from a password manager.
2. Set `DETENT_SESSION_SECRET` to 32 or more random characters and keep it
   stable, or every restart signs everybody out.
3. Sign in, enrol in TOTP, and store the ten recovery codes somewhere that is
   not the same laptop.
4. Configure the email provider, then test `/console/forgot` end to end. A
   reset path nobody has tried is a reset path that does not work.
5. Set the host variables so the console has a hostname of its own. The
   deployment refuses to start if the console shares a hostname with the
   marketing, app or reseller site.
