import { describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { AccountService, InMemoryAccountStore, InMemorySubscriptionStore, InMemoryPlanCatalogueStore,
  PlanCatalogueService, SubscriptionService, money } from '@detent/awa-billing';
import { Database, migrate, PostgresPlanCatalogueStore, PostgresSubscriptionStore } from '@detent/awa-persistence';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const clock = new FixedClock(new Date('2026-03-01T09:00:00Z'));
const audit = () => new AuditLog(new InMemoryAuditStore(), clock);
const input = (tenantId: string) => ({ accountId: `a_${tenantId}`, tenantId, planCode: 'growth' as const,
  interval: 'monthly' as const, billingEmail: 'buyer@example.com', billingName: 'Buyer', countryCode: 'GB', actor: 'operator', correlationId: tenantId });
const uplift = async (catalogue: PlanCatalogueService, amount = 85000) => {
  const draft = await catalogue.draft('growth', { platformFeeMonthly: money(amount), includedCreditsPence: 19000,
    connectorEntitlement: { tier1: 7 } }, { createdBy: 'first', changeNote: 'Reviewed new terms' });
  await catalogue.publish('growth', draft.version, 'second');
  return draft.version;
};

describe('published subscription prices', () => {
  it('new sales use published terms while existing and legacy subscriptions retain their version', async () => {
    const store = new InMemoryPlanCatalogueStore();
    const catalogue = new PlanCatalogueService(store, clock);
    await catalogue.seed();
    const subscriptions = new InMemorySubscriptionStore();
    const service = new SubscriptionService(subscriptions, audit(), clock, catalogue);
    const old = await service.create(input('old'));
    await uplift(catalogue);
    const current = await service.create(input('new'));
    expect(current.planVersion).toBe(2);
    expect((await service.planFor(current)).platformFee.monthly.amount).toBe(85000);
    expect((await service.planFor(old)).platformFee.monthly.amount).toBe(75000);
    const legacy = { ...old, planSnapshot: undefined };
    expect((await service.planFor(legacy)).platformFee.monthly.amount).toBe(75000);
    await expect(service.planFor({ ...legacy, planVersion: 999 })).rejects.toThrow('Agreed subscription terms');
    // Reconstruct services and subscription documents, as a fresh process does.
    const restarted = new PlanCatalogueService(store, clock);
    await restarted.seed();
    const reloaded = new SubscriptionService(subscriptions, audit(), clock, restarted);
    await uplift(restarted, 95000);
    expect((await reloaded.planFor(JSON.parse(JSON.stringify(current)))).platformFee.monthly.amount).toBe(85000);
    expect((await restarted.current('growth'))?.version).toBe(3);
  });

  it('account subscriptions pin the published price, credits and connector limits', async () => {
    const catalogue = new PlanCatalogueService(new InMemoryPlanCatalogueStore(), clock);
    await catalogue.seed();
    await uplift(catalogue);
    const store = new InMemoryAccountStore();
    const accounts = new AccountService(store, clock, catalogue);
    const account = await accounts.create({ name: 'Buyer', tenantId: 'buyer', billingEmail: 'buyer@example.com', countryCode: 'GB', createdBy: 'operator' });
    const sold = await accounts.startSubscription({ accountId: account.accountId, planCode: 'growth', term: 'rolling_monthly',
      billingInterval: 'monthly', startDate: clock.iso(), createdBy: 'operator' });
    expect(sold.planVersion).toBe(2);
    expect(sold.contractedPlatformFee.amount).toBe(85000);
    expect(sold.monthlyCreditsPence).toBe(19000);
    expect(sold.limits.connectorsTier1).toBe(7);
    await uplift(catalogue, 95000);
    const recovered = await new AccountService(store, clock, catalogue).subscription(account.accountId);
    expect(recovered?.contractedPlatformFee.amount).toBe(85000);
  });

  it('previews from agreed terms and refuses a price changed after confirmation', async () => {
    const catalogue = new PlanCatalogueService(new InMemoryPlanCatalogueStore(), clock);
    await catalogue.seed();
    const service = new SubscriptionService(new InMemorySubscriptionStore(), audit(), clock, catalogue);
    const sold = await service.create(input('change'));
    await uplift(catalogue);
    const preview = await service.preview(sold, { planCode: 'growth' });
    expect(preview.creditForUnusedTerm.amount).toBe(75000);
    expect(preview.chargeForRemainingTerm.amount).toBe(85000);
    await uplift(catalogue, 95000);
    await expect(service.changePlan({ subscriptionId: sold.subscriptionId, planCode: 'growth', actor: 'operator', correlationId: 'change', acknowledgedNetDue: preview.netDueNow })).rejects.toThrow('net amount changed');
    const fresh = await service.preview(sold, { planCode: 'growth' });
    const changed = await service.changePlan({ subscriptionId: sold.subscriptionId, planCode: 'growth', actor: 'operator', correlationId: 'change', acknowledgedNetDue: fresh.netDueNow });
    expect(changed.subscription.planVersion).toBe(3);
    expect((await service.planFor(changed.subscription)).platformFee.monthly.amount).toBe(95000);
  });

  it('protects historical terms and leaves the published version intact on a rejected switch', async () => {
    const store = new InMemoryPlanCatalogueStore();
    const catalogue = new PlanCatalogueService(store, clock);
    await catalogue.seed();
    const original = (await catalogue.current('growth'))!;
    await expect(store.put({ ...original, platformFee: { ...original.platformFee, monthly: money(1) } })).rejects.toThrow();
    original.platformFee.monthly = money(1);
    expect((await catalogue.current('growth'))?.platformFee.monthly.amount).toBe(75000);
    const draft = await catalogue.draft('growth', {}, { createdBy: 'first', changeNote: 'test' });
    await expect(store.publish({ ...draft, state: 'published' }, 999)).rejects.toThrow();
    expect((await catalogue.current('growth'))?.version).toBe(1);
  });
});

const url = process.env['TEST_DATABASE_URL'];
describe('Postgres pricing restart', () => {
  if (!url) it.skip('requires TEST_DATABASE_URL for a disposable database', () => undefined);
  else it('recovers drafts and published historical terms through a new pool', async () => {
    let db = new Database({ connectionString: url });
    try {
      await migrate(db, resolve('db/migrations'));
      let catalogue = new PlanCatalogueService(new PostgresPlanCatalogueStore(db), clock);
      await catalogue.seed();
      const previous = (await catalogue.current('growth'))!;
      const version = await uplift(catalogue);
      const sold = await new SubscriptionService(new PostgresSubscriptionStore(db), audit(), clock, catalogue).create(input(`pricing_${randomUUID()}`));
      const draft = await catalogue.draft('growth', {}, { createdBy: 'first', changeNote: 'Unpublished restart test' });
      await db.close();
      db = new Database({ connectionString: url });
      catalogue = new PlanCatalogueService(new PostgresPlanCatalogueStore(db), clock);
      await catalogue.seed();
      expect((await catalogue.current('growth'))?.version).toBe(version);
      expect((await catalogue.versionFor('growth', previous.version))?.state).toBe('withdrawn');
      expect((await catalogue.versionFor('growth', draft.version))?.state).toBe('draft');
      const recovered = (await new PostgresSubscriptionStore(db).get(sold.subscriptionId))!;
      expect(recovered.planSnapshot).toEqual(sold.planSnapshot);
      expect((await new SubscriptionService(new PostgresSubscriptionStore(db), audit(), clock, catalogue).planFor(recovered)).platformFee.monthly.amount).toBe(85000);
      await expect(new PostgresPlanCatalogueStore(db).put({ ...(await catalogue.current('growth'))!, name: 'Overwrite' })).rejects.toThrow();
      // Force the second UPDATE to fail inside a real transaction. The previous
      // published version must survive rollback, including through a fresh pool.
      const transaction = db.transaction.bind(db);
      const failing = {
        transaction: (body: (client: any) => Promise<void>) => transaction(async client => body({
          query: async (sql: string, values: unknown[]) => {
            if (sql.startsWith('UPDATE plan_version') && values[1] === draft.version) throw new Error('simulated publication failure');
            return client.query(sql, values);
          },
        })),
      } as unknown as Database;
      await expect(new PostgresPlanCatalogueStore(failing).publish({ ...draft, state: 'published', publishedAt: clock.iso(), publishedBy: 'second' }, version)).rejects.toThrow('simulated publication failure');
      await db.close();
      db = new Database({ connectionString: url });
      catalogue = new PlanCatalogueService(new PostgresPlanCatalogueStore(db), clock);
      expect((await catalogue.current('growth'))?.version).toBe(version);
      expect((await catalogue.versionFor('growth', draft.version))?.state).toBe('draft');
    } finally { await db.close(); }
  });
});
