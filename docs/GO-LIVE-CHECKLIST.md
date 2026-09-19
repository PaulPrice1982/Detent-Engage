# Detent Engage, go-live checklist for Tom and Tony

Companion to the Go-Live Brief of September 2026, updated against the code as it
now stands. Where the brief and this document disagree, this one is right: the
brief was written against a build that did not compile.

Owner split is a proposal. Tom: infrastructure, security operations, assurance.
Tony: integrations, legal, commercial. **Joint** means both sign.

---

## 1. What changed since the brief was written

The brief opened by saying nothing should be deployed, demoed as production or
sent to a pen tester until the build was green. That condition is now met, and
three things it did not know about have been dealt with.

| The brief said | Now |
|---|---|
| Does not typecheck; 58 of 587 tests fail | Typechecks clean. 1,224 tests pass, zero skipped, against a real PostgreSQL and Redis |
| Nine packages not wired into the build | Wired. 22 test files that never loaded now run, which is where the missing 600 tests were |
| No way to run it durably | A production entry point that refuses to start on a missing secret or an unreachable database, and reports durability measured from the stores rather than declared |
| Migrations would fail on any managed Postgres | Verified on PostgreSQL 16: apply, re-apply as a no-op, recover a database whose version ledger was lost, and apply as a role that cannot create roles |
| Redis rate limiting open | Implemented. Needs a managed Redis (A4) to switch on |
| Admin MFA open | TOTP enrolment implemented, verified against the RFC 6238 test vectors |
| Live-Postgres CI open | Four CI jobs including the suite under a role that cannot bypass row-level security |

**Three findings the brief did not contain.** Two are closed; one is the
remaining pilot blocker.

1. **The websites were never served.** The entry point mounted the API and
   nothing else, so every sign-in page, the staff console, the customer area and
   the reseller portal returned 404 in every deployment. Closed.
2. **Five tenant-scoped tables had no row-level security at all** (`auth_user`,
   `account`, `subscription`, `invoice`, `support_request`). Closed for every
   tenant-bound path; see risk R2.
3. **API keys are held in memory and lost on every restart.** Open. This is the
   one thing that will visibly break a pilot customer. See risk R1.

---

## 2. Engineering, before a pilot (Tom to schedule, engineering to do)

| # | Item | Why it blocks | Effort |
|---|---|---|---|
| E1 | **Persist API keys** to the `api_key` table, which already exists and is unused, and add a console route to issue the first server key | Every embedded widget stops working on every redeploy. A pilot customer sees this before we do | 1 session |
| E2 | **Console user management screen** (create, set role, disable, end sessions) | The service layer is complete and there is no screen. A second operator currently needs an engineer, and separation of duty is unenforceable while one account holds both roles | 1 session |
| E3 | **Cloud KMS key provider** | Depends on the cloud decision (A1). Until then credentials are encrypted under a local key that must be supplied as a secret | 1 session after A1 |
| E4 | Bind a tenant in the auth and billing stores, then remove the unbound escape clause in the platform row-level security policy | Closes R2 properly | 1 to 2 sessions |
| E5 | Wire OIDC, or remove the sign-in buttons | The buttons dead-end today, which reads as broken rather than unfinished | 1 session |

---

## 3. Infrastructure and security, Tom

| # | Item | Evidence for go-live | Lead time |
|---|---|---|---|
| A1 | **Cloud and region decision** (Joint). AWS or GCP, London primary. Decide whether EU residency is offered at launch or struck from the Enterprise tier | Signed decision note | Days |
| A2 | Accounts and IAM: separate dev/staging/prod, SSO into the console, MFA enforced, no long-lived root keys, CI deploys by OIDC federation not static keys | IAM policy export | 1 week |
| A3 | **Managed Postgres 16**, private subnet, TLS required, PITR 7 days or more, automated backups, an application role that is `NOBYPASSRLS` and separate from the owner | Restore drill record | 1 week |
| A4 | **Managed Redis** for rate limits and counters. TLS, auth, no public endpoint | Config screenshot | Days |
| A5 | KMS and secrets manager: root key, checkpoint key, model key, PSP keys, session secret. Rotation schedule documented | Key inventory and rotation policy | Days |
| A6 | Container platform and network: WAF in front, egress allow-list, private database and Redis, no SSH | Architecture diagram | 1 to 2 weeks |
| A7 | DNS and TLS for four hostnames: marketing, app, **console on its own hostname**, reseller. The build refuses to start if the console shares one | DNS export, SSL Labs A+ | Days |
| A8 | CI/CD: branch protection with the four CI jobs required, staged deploy with manual approval to production, rollback tested once | Protected-branch settings, deploy log | 1 week |
| A9 | Supply-chain policy: minimum release age of 7 days, Dependabot or Renovate, SBOM retained per release | Policy in repo settings | Days |

The repository already carries the CI workflow, a migration runner, a secret
linter and a dependency-age check. A8 and A9 are switching them on and making
them required, not building them.

---

## 4. Integrations, Tony

| # | Item | Evidence | Lead time |
|---|---|---|---|
| B1 | **Model provider**: Anthropic organisation account, production key in KMS, spend limits set at the provider, zero-data-retention and DPA terms in writing, model id pinned | Signed DPA, key in secrets manager | 1 week; enterprise terms 2 to 4 weeks |
| B2 | **CRM OAuth apps**: HubSpot, Salesforce, Pipedrive, Dynamics. Minimal scopes, sandbox orgs, marketplace approval where required | App ids, approved listings, sandbox test log | HubSpot and Pipedrive 1 to 2 weeks; Salesforce and Microsoft 4 to 8 weeks |
| B3 | **Transactional email**, with DKIM, SPF and DMARC on the sending domain | DNS records, provider account | 1 to 3 weeks |
| B4 | Payment service provider: Stripe live keys in KMS, webhook secret, tax settings, no card data on the platform | Stripe live, webhook verified in staging | 1 to 2 weeks including KYC |
| B5 | Identity provider for staff console access, and a decision on customer bring-your-own-IdP at launch | IdP app registration, MFA policy | 1 week |
| B6 | Consent-management platform testing against the CMPs pilot customers actually use | Test matrix | 1 week, after pilots named |

**B3 is higher priority than the brief implied.** Password reset is the only
self-service route back into any account. Until email is configured, reset links
are written to the process log instead of being sent, which both fails the user
and puts a credential into the log aggregator.

---

## 5. Independent verification

| # | Item | Owner | Gate |
|---|---|---|---|
| C1 | Green CI on a clean clone, including the Postgres and Redis jobs | Tom | Pilot. **Met today**, to be kept met by making the jobs required |
| C2 | Staging acceptance: deploy to A3 to A7, run the golden path end to end, and the restart test | Tom | Pilot |
| C3 | Load test at pilot concurrency times five; rate limits and spend caps hold; no cross-tenant errors | Tom | Pilot |
| C4 | **Penetration test**, CREST or CHECK accredited. Scope: API, widget, console, all three sign-in realms, MFA, webhooks, multi-tenant isolation on real RLS. **Book now, test after C2** | Tony books, Tom scopes | GA |
| C5 | Independent WCAG 2.2 AA audit of the widget and console | Tony books | GA |
| C6 | Real-site browser matrix on pilot customers' own sites, including strict-CSP hosts | Tom | Pilot |
| C7 | Disaster-recovery drill: restore PITR to a fresh instance, boot against it, record RTO and RPO. Repeat quarterly | Tom | Pilot |
| C8 | Model evaluation sign-off against the live provider on our own corpus | Tom | Pilot |

---

## 6. Operations, Tom

| # | Item |
|---|---|
| D1 | Observability destination and OTLP credentials; import the alert rules; route alerts to a paging tool |
| D2 | On-call rota, severity definitions, escalation, customer notification template, post-incident template |
| D3 | Backups and restore: PITR on, monthly restore test, backup encryption keys in KMS |
| D4 | **Public status page** with components for API, widget CDN, console and CRM sync; subscribe pilot customers |
| D5 | Retention, DSAR intake channel and 30-day SLA, deletion procedure, completions logged |
| D6 | Cost monitoring on cloud, model provider and PSP, reviewed weekly during pilot |
| D7 | Quarterly access review and a joiner/leaver checklist covering cloud, database, IdP and provider consoles |

---

## 7. Legal and trust, Tony

| # | Item | Gate |
|---|---|---|
| E1 | Terms of Service and Order Form, with AI-specific terms and an SLA schedule per tier | Pilot (pilot agreement acceptable) |
| E2 | Data Processing Agreement: Article 28 terms, sub-processor list, transfer mechanism, 30-day notice of change | Pilot |
| E3 | Privacy notice and widget disclosure, visitor-facing and tenant-facing | Pilot |
| E4 | DPIA and legitimate-interest assessment: profiling of website visitors, enrichment vendors, transfer to the model provider | Pilot |
| E5 | ROPA, retention schedule, breach procedure with the 72-hour ICO path | Pilot |
| E6 | Cyber and professional indemnity insurance | GA |
| E7 | Publish the trust page and security questionnaire; decide Cyber Essentials Plus now and an ISO 27001 or SOC 2 roadmap | GA |
| E8 | Accessibility statement, published once C5 is done | Now: the code already refuses to claim conformance without a named auditor and a date, so nothing needs correcting |
| E9 | Residency claim: only market UK or EU residency once A1 exists and routing is built | Now |

---

## 8. Commercial, Tony (Joint on pricing)

| # | Item |
|---|---|
| F1 | **Scope freeze (Joint)**: the v1.0 spine is the only thing on the GA path. CMS, reseller programme, support desk and voice stay behind flags |
| F2 | Pricing sign-off. The catalogue now carries five plans including the self-serve **Answers** tier at £9.99 a month and 50p a reply, capped at six chargeable replies per conversation. Confirm those numbers and that the outcome basis per tier is what the contract will say |
| F3 | Two to three design-partner pilots: named, contracted, with written success criteria |
| F4 | Sales collateral: assurance pack sample, ROI model, security questionnaire, architecture one-pager |
| F5 | Support model: hours, channels and SLA per tier |
| F6 | Marketplace listings, after B2 approval. Post-GA |

---

## 9. Gates

**Pilot gate, all required:**

1. C1 green CI on a clean clone, with the Postgres and Redis jobs required on the branch.
2. **E1 and E2 done.** Without E1 every widget breaks on every deploy; without E2 there is no way to add a second operator.
3. Staging boots durably (C2) and survives the restart test. The production entry point refuses any in-memory fallback.
4. A3 to A8 in place; every secret in KMS or the secrets manager.
5. MFA enrolled by every member of staff with console access.
6. B1 model DPA signed; B2 sandbox tests passing for the pilots' CRMs; **B3 email live and password reset tested end to end**.
7. C3 load test and C7 restore drill recorded.
8. E1 to E5 signed. E9 copy corrected.
9. D1, D2 and D4 live.

**GA gate adds:**

10. C4 pen test, highs retested and closed, report available under NDA.
11. C5 accessibility audit passed and the statement published.
12. Two pilots meeting their success criteria for 60 days with zero isolation or evidence incidents.
13. E6 insurance bound; E7 trust page live.
14. E3, E4 and E5 done.

---

## 10. Open risks, stated plainly

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **API keys do not survive a restart** | Every embedded widget stops working on every deploy. The customer notices first | E1, before any pilot |
| R2 | The five platform tables permit unbound access, because sign-in looks a user up by email before a tenant is known | A forgotten filter in auth or billing code could cross tenants. Every tenant-bound path is already confined | E4 |
| R3 | No console user management screen | One account holds both `admin` and `owner`, so separation of duty exists in the model and not in practice | E2 |
| R4 | SSO buttons dead-end | Reads as broken to an enterprise buyer evaluating us | E5 |
| R5 | No penetration test and no accessibility audit | Both will be asked for in procurement, and the insurer will ask for C4 | C4, C5. Book now, the lead time is the constraint |
| R6 | Credentials encrypted under a local key until KMS exists | The root key must be handled as a secret and rotated by hand | E3 after A1 |
| R7 | One staff account, and its password is an environment variable | Anyone who can read the deployment configuration can sign in as the operator | E2, then per-person accounts and MFA for each |

---

## 11. The first two weeks

- **Day 1 to 2 (Joint):** A1 cloud and region. F1 scope freeze. F2 confirm the Answers tier pricing. Hand E1 and E2 to engineering.
- **Week 1 (Tom):** A2, A5, A7, A9. Open the D1 account. Make the four CI jobs required on the protected branch.
  **(Tony):** B1 account and DPA request. B2 registrations, Salesforce and Microsoft first because they are the longest. **B3 email provider, because reset is the only way back into an account.** B4 Stripe KYC. Book C4 for about six weeks out. Brief legal on E1 to E5.
- **Week 2 (Tom):** A3, A4, A6, A8 skeleton. D4 status page. Run C7 once by hand.
  **(Tony):** B5. Name the pilots (F3). Insurer quotes (E6).

**The single highest-impact action this week:** persist the API keys (E1). It is
roughly a session of work, and until it lands every deployment silently breaks
every embedded widget, which is the one failure a pilot customer sees before we
do.
