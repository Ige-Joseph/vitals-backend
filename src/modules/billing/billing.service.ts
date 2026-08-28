import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { entitlementService } from './entitlement.service';
import { grantService } from './grant.service';
import { checkoutService } from './checkout.service';
import { providerRegistry } from './provider/provider.registry';
import {
  TIER_ENTITLEMENTS,
  TIER_DESCRIPTIONS,
  describePrices,
  type BillingTier,
  type TierDescription,
} from '@/config/billing.config';

const log = createLogger('billing-service');

/**
 * The billing tier — `PlanType` on User, not `CarePlan`.
 *
 * The two are unrelated and the codebase calls both "plan". A CarePlan is a
 * course of care and is person-scoped; PlanType is what an account pays for
 * and is account-scoped, permanently. Nothing here touches CarePlan.
 *
 * Until now nothing in the codebase ever wrote planType, so every account was
 * FREE forever: the meter was built and the door never was. This is the door.
 * It deliberately stops short of a payment provider — the write path and the
 * entitlement wiring come first, so a provider only has to call `setPlan`.
 */
export const billingService = {
  /**
   * Where a subscription is actually bought.
   *
   * Purchase happens on the web, outside any app store's payment flow. That is
   * a commercial decision as much as a technical one: an in-app digital
   * purchase on Play would have to go through Play Billing, at a fee that
   * matters on a low-priced subscription in this market.
   *
   * Returned as an absolute URL so a wrapped build opens it in a browser
   * rather than rendering it inside the app.
   */
  checkoutUrl(): string {
    return `${env.FRONTEND_URL.replace(/\/$/, '')}/billing`;
  },

  /**
   * Put the configured prices in the table, so a subscription can point at a
   * row that outlives the config.
   *
   * Insert-only. An existing row is never updated, because a price anyone may
   * have bought must not change underneath them — repricing means adding a new
   * config entry with a new id, which appears here as a new row.
   */
  async syncPrices(): Promise<{ inserted: number }> {
    const configured = Object.values(TIER_DESCRIPTIONS).flatMap((tier) =>
      tier.prices.map((price) => ({ ...price, tier: tier.tier })),
    );

    let inserted = 0;
    for (const price of configured) {
      const created = await prisma.price.createMany({
        data: [
          {
            id: price.id,
            tier: price.tier,
            label: price.label,
            amountMinor: price.amountMinor,
            currency: price.currency,
            interval: price.interval,
            intervalCount: price.intervalCount,
            active: price.active,
            provisional: price.provisional,
          },
        ],
        skipDuplicates: true,
      });
      inserted += created.count;
    }

    if (inserted > 0) log.info('Prices synced from config', { inserted });
    return { inserted };
  },

  /**
   * A tier with its sellable periods decorated — per-month cost and the saving
   * against the dearest option, computed rather than left to the client so
   * every surface shows the same number.
   */
  describeTier(tier: TierDescription) {
    return { ...tier, prices: describePrices(tier.prices) };
  },

  /**
   * What the tiers are, for anyone at all.
   *
   * Deliberately account-free: no user is consulted, nothing here varies by
   * caller, and so nothing here needs a caller. That is what lets it sit in
   * front of `authenticate` and makes a shared link to the billing page work
   * for someone who has never signed in.
   *
   * The account-specific half — which tier you are on, what you have been
   * granted, what you are subscribed to — stays behind authentication in
   * `getPlan`, which returns this as well so an existing client keeps seeing
   * one payload.
   */
  publicPlans() {
    return {
      tiers: Object.values(TIER_DESCRIPTIONS).map(billingService.describeTier),
      checkoutUrl: billingService.checkoutUrl(),
      // Whether a purchase can actually be started right now. The page needs
      // to know: an upgrade button that leads to "no provider configured" is
      // worse than one that is honestly absent.
      checkoutAvailable: providerRegistry.isConfigured,
    };
  },

  /** The caller's tier, what it grants, and what the other tier would. */
  async getPlan(userId: string) {
    // Entitlement comes from what is being paid for; planType is a projection.
    const [entitlement, pendingCheckout] = await Promise.all([
      entitlementService.resolve(userId),
      checkoutService.pending(userId),
    ]);
    const tier = entitlement.tier;

    return {
      tier,
      subscription: entitlement.subscription,
      /**
       * A checkout started and not yet finished.
       *
       * An INCOMPLETE subscription grants nothing and so never appears in
       * `subscription`, which left it invisible: someone who closed the tab
       * mid-payment and came back had no way to be told anything was in
       * flight. This is that missing signal.
       */
      pendingCheckout,
      entitlementSource: entitlement.source,
      description: billingService.describeTier(TIER_DESCRIPTIONS[tier]),
      // The account's actual columns, which may differ from the tier default
      // if someone was granted an override.
      entitlements: {
        managedPersonLimit: entitlement.managedPersonLimit,
        connectionLimit: entitlement.connectionLimit,
      },
      // The same tiers, prices and availability an anonymous caller gets, so
      // one client reading one endpoint still sees one payload.
      ...billingService.publicPlans(),
    };
  },

  /**
   * Write the tier and apply its entitlements.
   *
   * This is the single write path. A payment provider, an admin action and a
   * support script all land here rather than each setting columns themselves.
   *
   * Limits are a ceiling on *new* only — nothing is taken away on downgrade.
   * An account that drops below its limit keeps every Person it already has;
   * health data must never become read-only because a subscription lapsed.
   */
  /**
   * Grant or revoke Premium, as an admin.
   *
   * Kept as "set the plan" because that is what an admin is doing and what the
   * route is called, but it no longer writes `planType` and walks away. PREMIUM
   * opens an EntitlementGrant; FREE revokes the one that is running. Either way
   * there is a row saying who decided, when, why, and — if it was time-limited
   * — until when.
   *
   * Subscriptions are untouched by both. An admin cannot cancel someone's
   * subscription from here, and revoking a grant leaves what they paid for
   * exactly as it was.
   */
  async setPlan(input: {
    userId: string;
    tier: BillingTier;
    actorUserId: string;
    basis: string;
    expiresAt?: Date | null;
  }) {
    const { userId, tier, actorUserId, basis, expiresAt } = input;

    if (tier === 'PREMIUM') {
      await grantService.grant({
        userId,
        tier,
        reason: basis,
        expiresAt: expiresAt ?? null,
        actorUserId,
      });
    } else {
      await grantService.revoke({ userId, reason: basis, actorUserId });
    }

    // Read back through the projection the grant service just synced, so the
    // response describes the account as every other read will see it.
    return prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        planType: true,
        emailVerified: true,
        managedPersonLimit: true,
        connectionLimit: true,
      },
    });
  },

};
