/**
 * What each billing tier grants.
 *
 * Entitlement is account-scoped and always has been: quota is metered per
 * login, and capacity counts people an account manages or connects to. None of
 * it is ever person-scoped — a Person must never become a multiplier for
 * anything you can buy.
 *
 * The two capacity axes are independent on purpose. Managing a dependent who
 * has no account is a different thing from connecting to an adult who has one,
 * and a tier can move one without the other.
 *
 * These limits are applied to the account's columns when the tier changes, not
 * read through from the tier at query time. That keeps a per-account override —
 * a support grant, a pilot user — possible without inventing a third tier.
 */

export type BillingTier = 'FREE' | 'PREMIUM';

export interface TierEntitlements {
  /** Dependents with no Vitals account of their own. */
  managedPersonLimit: number;
  /** Adults with their own account who have shared their record. */
  connectionLimit: number;
}

export const TIER_ENTITLEMENTS: Record<BillingTier, TierEntitlements> = {
  // Self only. A self-Person consumes neither axis, and the first baby is
  // exempt from managed capacity, so the free tier still covers the whole
  // mother-baby journey for one child.
  FREE: {
    managedPersonLimit: 0,
    connectionLimit: 0,
  },

  PREMIUM: {
    managedPersonLimit: 5,
    connectionLimit: 5,
  },
};

/**
 * A price someone can buy a tier at.
 *
 * Amounts are in minor units — kobo — so no float ever touches money.
 *
 * ── Repricing, and why `id` and `active` exist ──────────────────────────
 *
 * When the price changes, whoever already subscribed keeps what they signed
 * up at. That only works if a price is an immutable *record* rather than a
 * number that gets edited, so the rule for changing a price is:
 *
 *   1. add a new entry with a new `id`
 *   2. set `active: false` on the old one
 *   3. never edit `amountMinor` on an entry anyone may have bought
 *
 * Retired entries stay in this file. A subscription (once a provider exists)
 * stores the `id` it was bought at, and resolving that id has to keep working
 * for as long as anyone holds it — which is what lets a renewal charge the
 * old amount and a receipt describe it correctly years later.
 *
 * Only `active` entries are offered for purchase; `priceById` resolves any
 * entry, live or retired. Nothing here enforces grandfathering yet — there is
 * no subscription table to enforce it against — but nothing here prevents it
 * either, which is the point.
 */
export interface BillingPrice {
  /** Stable and immutable. Never reused, never repointed at a new amount. */
  id: string;
  label: string;
  amountMinor: number;
  currency: 'NGN';
  /** Billing period, expressed as data so a new one is an entry, not a branch. */
  interval: 'month' | 'year';
  intervalCount: number;
  /** Offered for purchase. Retired prices stay resolvable for existing holders. */
  active: boolean;
  /**
   * Not yet validated against real users. Both current amounts are guesses at
   * what this market will bear; neither has been tested.
   */
  provisional: boolean;
}

/** Months a period covers, so any interval normalises without branching. */
const MONTHS_PER_INTERVAL: Record<BillingPrice['interval'], number> = {
  month: 1,
  year: 12,
};

export const monthsIn = (price: BillingPrice): number =>
  MONTHS_PER_INTERVAL[price.interval] * price.intervalCount;

/** What the period works out to per month, for comparing unlike periods. */
export const perMonthMinor = (price: BillingPrice): number =>
  Math.round(price.amountMinor / monthsIn(price));

export interface PricedPeriod extends BillingPrice {
  perMonthMinor: number;
  /** Whole-percent saving against the costliest period per month. 0 if none. */
  savingPercent: number;
  savingMinorPerYear: number;
}

/**
 * Decorate the sellable prices for a tier with their per-month cost and the
 * saving against the dearest option.
 *
 * The baseline is derived — the period with the highest per-month cost — not
 * hardcoded to "monthly". Add a quarterly price and it slots in without this
 * function changing.
 */
export const describePrices = (prices: BillingPrice[]): PricedPeriod[] => {
  const sellable = prices.filter((p) => p.active);
  if (sellable.length === 0) return [];

  // Compare annualised, not per-month. perMonthMinor rounds to whole kobo, and
  // multiplying a rounded figure back up drifts — ₦10,000/year would report a
  // saving of ₦2,000.04 rather than ₦2,000.
  const annualised = (price: BillingPrice) =>
    Math.round((price.amountMinor * 12) / monthsIn(price));

  const baseline = Math.max(...sellable.map(annualised));

  return sellable
    .map((price) => {
      const perYear = annualised(price);
      return {
        ...price,
        perMonthMinor: perMonthMinor(price),
        savingPercent:
          baseline === 0 ? 0 : Math.round(((baseline - perYear) / baseline) * 100),
        savingMinorPerYear: baseline - perYear,
      };
    })
    .sort((a, b) => monthsIn(a) - monthsIn(b));
};

export interface TierDescription {
  tier: BillingTier;
  name: string;
  summary: string;
  includes: string[];
  /** Empty for a tier nobody pays for. Every sellable period, cheapest first. */
  prices: BillingPrice[];
}

/**
 * What a tier includes, in the words a person would use.
 *
 * Deliberately says nothing about AI limits being the product. The care engine
 * is what is being sold: reminders, continuity, and the people around you.
 */
export const TIER_DESCRIPTIONS: Record<BillingTier, TierDescription> = {
  FREE: {
    tier: 'FREE',
    name: 'Free',
    summary: 'Your own health record, and your first baby.',
    includes: [
      'Your own medications, reminders and history',
      'Full pregnancy journey with antenatal reminders',
      'Your first baby, including their vaccination schedule',
      'Symptom checks and medicine scans, with a daily limit',
    ],
    prices: [],
  },
  PREMIUM: {
    tier: 'PREMIUM',
    name: 'Premium',
    summary: 'Care for the people around you, not just yourself.',
    includes: [
      'Everything in Free',
      'Manage up to 5 people — more children, a parent, anyone in your care',
      'Connect with up to 5 adults who share their record with you',
      'Their reminders and history alongside your own',
    ],
    // Both provisional until validated against real users. To change either,
    // add a new entry and retire the old one — never edit an amount in place.
    prices: [
      {
        id: 'premium-monthly-2026-08',
        label: 'Monthly',
        amountMinor: 100_000, // ₦1,000
        currency: 'NGN',
        interval: 'month',
        intervalCount: 1,
        active: true,
        provisional: true,
      },
      {
        id: 'premium-annual-2026-08',
        label: 'Yearly',
        amountMinor: 1_000_000, // ₦10,000 — two months free against monthly
        currency: 'NGN',
        interval: 'year',
        intervalCount: 1,
        active: true,
        provisional: true,
      },
    ],
  },
};

/**
 * Resolve any price by id, live or retired.
 *
 * Existing subscribers hold ids that may no longer be for sale, and a renewal
 * or a receipt still has to describe them.
 */
export const priceById = (id: string): BillingPrice | undefined =>
  Object.values(TIER_DESCRIPTIONS)
    .flatMap((tier) => tier.prices)
    .find((price) => price.id === id);
