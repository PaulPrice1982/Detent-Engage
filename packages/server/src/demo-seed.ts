/**
 * Puts a demonstration into a state worth showing.
 *
 * The approval queue lives in process memory, so nothing outside this process
 * can put an action on it. A demonstration whose Approvals screen is empty
 * demonstrates nothing, and inventing the screenshot instead would be a
 * picture of a product that does not exist. So the actions below are requested
 * through the same `ConsoleService` the console uses, by a real console user,
 * subject to the same capability and dual-control rules: one grant lands under
 * the threshold and is executed, one lands over it and waits for a second
 * person, and a plan override waits whatever its value.
 *
 * Deliberately refused in a deployment. This writes credit to accounts, and a
 * fixture that can run against a customer's data is a fixture that eventually
 * will.
 */
import { money, type Money } from '@detent/awa-billing';
import type { ConsoleService, ConsoleUser } from '@detent/awa-console';
import type { UserService } from '@detent/awa-auth';
import type { AccountService } from '@detent/awa-billing';

export interface DemoSeedDeps {
  readonly consoleService: ConsoleService;
  readonly users: UserService;
  readonly accounts: AccountService;
  readonly deployed: boolean;
}

/** One requested action, and whether it is expected to wait for a second person. */
export interface SeededAction {
  readonly summary: string;
  readonly state: string;
}

async function consoleUser(users: UserService, email: string): Promise<ConsoleUser | undefined> {
  const user = await users.byEmail('console', email);
  if (!user) return undefined;
  return {
    userId: user.userId, email: user.email, name: user.name,
    roles: user.roles as ConsoleUser['roles'], active: user.active,
    mfaEnrolled: user.mfaEnrolled, createdAt: user.createdAt,
  };
}

export async function seedDemoActions(deps: DemoSeedDeps): Promise<readonly SeededAction[]> {
  if (deps.deployed) return [];
  // Two requesters on purpose. Billing may grant credit and may not change a
  // spend cap; commercial may do both. Seeding everything as one superuser
  // would produce a queue that no real console could have produced.
  const fallback = await consoleUser(deps.users, 'ops@detentgtm.io');
  const billing = await consoleUser(deps.users, 'm.whitlock@detentgtm.io') ?? fallback;
  const commercial = await consoleUser(deps.users, 'g.aldridge@detentgtm.io') ?? fallback;
  if (!billing || !commercial) return [];

  const all = await deps.accounts.list();
  const byTenant = new Map(all.map((account) => [account.tenantId, account]));
  const seeded: SeededAction[] = [];
  const expiry = new Date(Date.now() + 90 * 86_400_000).toISOString();

  const grant = async (
    tenantId: string, amount: Money, reason: string, kind: 'grant_goodwill' | 'grant_promotional',
  ): Promise<void> => {
    const account = byTenant.get(tenantId);
    if (!account) return;
    const action = await deps.consoleService.grantCredit(billing, {
      actionId: `demo_credit_${tenantId}`,
      accountId: account.accountId, tenantId,
      amount, kind, expiresAt: expiry, reason,
    });
    // Under the threshold the request comes back already approved, and the
    // grant only exists once it is executed. Over it, executing would throw,
    // which is the control working, so it is left on the queue.
    if (action.state === 'approved') {
      await deps.consoleService.executeCreditGrant(billing, action.actionId);
      seeded.push({ summary: action.summary, state: 'executed' });
    } else {
      seeded.push({ summary: action.summary, state: action.state });
    }
  };

  // £300 of goodwill: under the £500 threshold, so it applies on the spot.
  await grant('t_kestrel', money(30_000), 'Two days of degraded voice quality in August.', 'grant_goodwill');
  // £2,500 of promotional credit: over it, so it waits for a second person.
  await grant('t_northwind', money(250_000),
    'Agreed at the Q3 business review as the migration incentive.', 'grant_promotional');

  const halden = byTenant.get('t_halden');
  if (halden) {
    const action = await deps.consoleService.changeSpendCap(commercial, {
      actionId: 'demo_cap_t_halden',
      accountId: halden.accountId, tenantId: 't_halden',
      newCap: money(900_000),
      reason: 'Winter campaign. Raised from £5,500 to £9,000 for the quarter.',
    });
    seeded.push({ summary: action.summary, state: action.state });
  }

  const barrowfield = byTenant.get('t_barrowfield');
  if (barrowfield) {
    await deps.consoleService.holdDunning(billing, {
      accountId: barrowfield.accountId, tenantId: 't_barrowfield',
      untilIso: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      reason: 'Finance contact on leave. Agreed a fortnight by phone.',
    });
    seeded.push({ summary: 'Hold dunning for 14 days', state: 'executed' });
  }

  return seeded;
}

/**
 * A qualification the deterministic provider can hold end to end.
 *
 * The reference provider answers every input with one stock sentence unless it
 * is given a script, which makes a local run of the product look like a
 * chatbot that cannot hear. This is the script for the demonstration: a fleet
 * telematics enquiry, qualified over five turns, ending in a recorded outcome.
 *
 * It is a fixture and it is not the model. The turns below are fixed text, so
 * anything shown from them is a demonstration of the governance path, the
 * disclosure, the tool gate, the outcome ledger, and not of what the model
 * would say. With ANTHROPIC_API_KEY set, `main.ts` never constructs this.
 */
export const DEMO_CONVERSATION: readonly {
  readonly match: RegExp;
  readonly output: { text: string; confidence?: number; sentiment?: 'positive' | 'neutral' | 'negative';
    detectedTopics?: readonly string[]; toolCalls?: readonly { tool: string; args: Record<string, unknown> }[] };
}[] = [
  // Ordered most specific first: the provider takes the first entry that
  // matches, so a general pattern above a particular one swallows it. The
  // opening pattern is last for that reason.
  {
    match: /@/,
    output: {
      text: 'Booked. You will get a confirmation to that address with the slot and a short note on what they will cover. '
        + 'Nothing else will be sent to you, and you have not been added to any marketing list.',
      confidence: 0.93, sentiment: 'positive', detectedTopics: ['qualified', 'booked'],
      toolCalls: [{
        tool: 'record_outcome',
        args: {
          outcome: 'book_meeting',
          summary: '40-vehicle fleet, two Midlands depots. Telematics renewal with a 90-day notice window before March. '
            + 'Driver behaviour scoring in scope. Decision maker engaged.',
        },
      }],
    },
  },
  {
    match: /speak to (a|someone)|talk to a (human|person)|real person|call me back/i,
    output: {
      text: 'Of course. I am putting you through to the team now and passing on what you have told me so you do not repeat it.',
      confidence: 0.95, sentiment: 'neutral', detectedTopics: ['escalation'],
      toolCalls: [{ tool: 'escalate_to_human', args: { reason: 'visitor_request' } }],
    },
  },
  {
    match: /behaviour scoring|driver behaviour|driver scoring/i,
    output: {
      text: 'Forty vehicles with driver behaviour scoring puts you in the mid-fleet configuration rather than the enterprise one. '
        + 'I can give you the published band for that, but not a bespoke figure. '
        + 'Is the March date a hard stop, or is there a notice period that has to be served before it?',
      confidence: 0.9, sentiment: 'positive', detectedTopics: ['fleet_telematics', 'pricing', 'timing'],
    },
  },
  {
    match: /notice period|notice window|hard stop|break clause|auto.?renew/i,
    output: {
      text: 'Then the decision has to be made before the notice window closes, not before the contract ends. '
        + 'That is usually the date that catches people out. '
        + 'Are you the person who signs this off, or does it go to a board?',
      confidence: 0.88, sentiment: 'neutral', detectedTopics: ['timing', 'authority'],
    },
  },
  {
    match: /my call|i sign|i decide|goes to the board|my decision|i run the/i,
    output: {
      text: 'Useful, thank you. On what you have told me, this is a fit and worth twenty minutes with the fleet team. '
        + 'They can walk through the behaviour scoring and what the migration from your current provider involves. '
        + 'What is the best work email for the invitation?',
      confidence: 0.91, sentiment: 'positive', detectedTopics: ['qualified', 'next_step'],
    },
  },
  {
    match: /telematics|fleet|vans|vehicles|tracking|depot/i,
    output: {
      text: 'Replacing a telematics contract at renewal is the easiest time to change, so your timing is good. '
        + 'Two depots and vans suggests you care about utilisation as much as location. '
        + 'How many vehicles are in scope?',
      confidence: 0.92, sentiment: 'positive', detectedTopics: ['fleet_telematics', 'renewal'],
    },
  },
];
