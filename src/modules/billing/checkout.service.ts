import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { entitlementService } from './entitlement.service';
import { providerRegistry } from './provider/provider.registry';

const log = createLogger('billing-checkout');

/**
 * How long a started-but-unfinished checkout stays worth mentioning.
 *
 * An INCOMPLETE row is created before the payer ever reaches the provider and
 * is reused if they come back, so it outlives an abandoned attempt — nothing
 * ever cleans it up, because it is also how a provider-created subscription
 * gets matched back to us. Reporting it forever would leave "payment in
 * progress" on screen for someone who changed their mind a month ago.
 *
 * Two hours is longer than any checkout takes and shorter than a grudge.
 */
const PENDING_CHECKOUT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Starting a purchase.
 *
 * The order of operations here is the whole design, and it is dictated by one
 * fact: a webhook can arrive before the HTTP response to the call that caused
 * it. So nothing may exist provider-side that we have no row for.
 *
 *   1. Make sure the price is purchasable at the provider, and remember its
 *      handle on the Price row.
 *   2. Create — or reuse — our subscription row, INCOMPLETE, carrying the
 *      price id it is being bought at.
 *   3. Only then start the payment, passing our subscription id along so
 *      whatever comes back can be matched to it.
 *
 * Step 2 before step 3 is what makes the webhook handler's job possible. An
 * INCOMPLETE row grants nothing, so creating one early costs nothing if the
 * payer walks away.
 *
 * ── Grandfathering ───────────────────────────────────────────────────────
 *
 * The subscription stores `priceId` — the id of the immutable price record it
 * was bought at, not an amount copied out of config at the time. Repricing
 * means adding a new price with a new id, which creates a new plan at the
 * provider; everyone already subscribed stays attached to the old price and
 * the old provider plan, and keeps being charged the old amount by the
 * provider itself. Nothing has to remember to protect them.
 */
export const checkoutService = {
  /**
   * Where the provider sends the payer back to.
   *
   * Not a confirmation of anything. The payer can close the tab, the callback
   * can be missed, and the subscription still activates — because activation
   * comes from the webhook, not from the browser coming back.
   */
  returnUrl(): string {
    return `${env.FRONTEND_URL.replace(/\/$/, '')}/billing?checkout=returned`;
  },

  async start(input: { userId: string; priceId: string }) {
    const { userId, priceId } = input;

    const adapter = providerRegistry.requireDefault();

    const price = await prisma.price.findUnique({ where: { id: priceId } });
    if (!price) throw AppError.notFound('That price does not exist');
    if (!price.active) {
      // Retired prices stay resolvable for the people holding them and are not
      // sellable to anyone new. That is the entire mechanism.
      throw AppError.conflict('That price is no longer offered');
    }
    if (price.tier === 'FREE') {
      throw AppError.badRequest('The free plan is not something to buy');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, erasedAt: true },
    });
    if (!user) throw AppError.notFound('User not found');
    if (user.erasedAt) throw AppError.conflict('This account has been erased');

    // An account already getting what it would be buying should not be able to
    // buy it twice — two live subscriptions means two charges a month.
    const existing = await entitlementService.activeSubscription(userId);
    if (existing && existing.status !== 'CANCELED') {
      throw AppError.conflict('This account already has an active subscription');
    }

    // The provider's handle for this price, created once and remembered. The
    // remote lookup inside `ensurePlan` is the safety net for a database that
    // was rebuilt; ordinarily this branch is taken once in the product's life.
    let providerPlanId = price.providerPriceId;
    if (!providerPlanId || price.provider !== adapter.name) {
      providerPlanId = await adapter.ensurePlan({
        id: price.id,
        label: price.label,
        amountMinor: price.amountMinor,
        currency: price.currency,
        interval: price.interval,
        intervalCount: price.intervalCount,
      });

      await prisma.price.update({
        where: { id: price.id },
        data: { providerPriceId: providerPlanId, provider: adapter.name },
      });

      log.info('Price registered with the provider', {
        priceId: price.id,
        provider: adapter.name,
      });
    }

    // Reuse an attempt that was never paid for rather than leaving a trail of
    // abandoned rows. It matters beyond tidiness: matching a provider-created
    // subscription back to us can come down to "the row for this customer and
    // this price", and that has to identify exactly one row.
    const pending = await prisma.subscription.findFirst({
      where: {
        userId,
        priceId: price.id,
        status: 'INCOMPLETE',
        providerSubscriptionId: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    const subscription =
      pending ??
      (await prisma.subscription.create({
        data: {
          userId,
          priceId: price.id,
          status: 'INCOMPLETE',
          provider: adapter.name,
        },
      }));

    const previous = (subscription.providerMetadata as Record<string, unknown>) ?? {};
    const attempt = Number(previous.checkoutAttempt ?? 0) + 1;

    try {
      const session = await adapter.createCheckout({
        subscriptionId: subscription.id,
        priceId: price.id,
        providerPlanId,
        attempt,
        amountMinor: price.amountMinor,
        currency: price.currency,
        returnUrl: checkoutService.returnUrl(),
        // Handed back to us on the events that follow, and the strongest link
        // we have before the provider has named anything.
        metadata: {
          subscriptionId: subscription.id,
          userId,
          priceId: price.id,
        },
        customer: { email: user.email, reference: subscription.providerCustomerRef },
      });

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          ...(session.providerCustomerRef
            ? { providerCustomerRef: session.providerCustomerRef }
            : {}),
          providerMetadata: {
            ...previous,
            ...session.providerMetadata,
            checkoutAttempt: attempt,
          },
        },
      });

      log.info('Checkout started', {
        userId,
        subscriptionId: subscription.id,
        priceId: price.id,
        attempt,
      });

      return {
        redirectUrl: session.redirectUrl,
        subscriptionId: subscription.id,
        priceId: price.id,
        amountMinor: price.amountMinor,
        currency: price.currency,
      };
    } catch (err: any) {
      // A row we created and could not start a payment for is noise. One we
      // reused may have earlier attempts behind it, so it stays.
      if (!pending) {
        await prisma.subscription.delete({ where: { id: subscription.id } });
      }

      log.error('Checkout could not be started', {
        userId,
        priceId: price.id,
        error: err?.message,
      });

      if (err instanceof AppError) throw err;
      throw AppError.badRequest(
        'The payment provider could not start this checkout. Please try again.',
      );
    }
  },

  /**
   * A checkout that was started and has not turned into a subscription.
   *
   * This is what an INCOMPLETE row means, and it is deliberately *not* the
   * same claim as "a payment is being confirmed". We cannot tell those apart
   * from here: a payer who completed payment and a payer who closed the tab at
   * the provider leave behind exactly the same row, because the thing that
   * distinguishes them is a webhook that has not arrived in either case. The
   * caller is told what is true — a checkout was started, and when — and is
   * left to phrase it honestly.
   *
   * Bounded by `PENDING_CHECKOUT_WINDOW_MS`, since nothing else ever clears
   * these rows.
   */
  async pending(userId: string): Promise<{
    subscriptionId: string;
    priceId: string;
    startedAt: Date;
  } | null> {
    const row = await prisma.subscription.findFirst({
      where: {
        userId,
        status: 'INCOMPLETE',
        // updatedAt rather than createdAt: the row is reused across attempts,
        // so this is when the *current* attempt began.
        updatedAt: { gt: new Date(Date.now() - PENDING_CHECKOUT_WINDOW_MS) },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, priceId: true, updatedAt: true },
    });

    if (!row) return null;

    return {
      subscriptionId: row.id,
      priceId: row.priceId,
      startedAt: row.updatedAt,
    };
  },

  /**
   * Stop a subscription renewing, at the subscriber's request.
   *
   * Not the same call erasure makes. This one leaves the period they paid for
   * intact — `endedAt` stays null, so entitlement runs to `currentPeriodEnd` —
   * and only stops the next charge.
   */
  async cancel(input: { userId: string; subscriptionId: string }) {
    const subscription = await prisma.subscription.findFirst({
      where: { id: input.subscriptionId, userId: input.userId },
    });

    if (!subscription) throw AppError.notFound('Subscription not found');
    if (['CANCELED', 'EXPIRED'].includes(subscription.status)) {
      throw AppError.conflict('That subscription has already been cancelled');
    }

    const now = new Date();
    const result = await providerRegistry.tryCancel(subscription, 'subscriber-request');

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'CANCELED',
        cancelAtPeriodEnd: true,
        canceledAt: now,
        // Deliberately not set. They keep what they bought until the period
        // ends; entitlement is bounded by currentPeriodEnd, not by this.
        endedAt: null,
        cancellationRequestedAt: now,
        cancellationConfirmedAt: result.confirmed ? now : null,
      },
    });

    log.info('Subscription cancelled by subscriber', {
      subscriptionId: subscription.id,
      confirmed: result.confirmed,
      detail: result.detail,
    });

    return {
      cancelled: true,
      confirmedByProvider: result.confirmed,
      accessUntil: subscription.currentPeriodEnd,
    };
  },
};
