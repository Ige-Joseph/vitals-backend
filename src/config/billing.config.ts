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

export interface TierPrice {
  /** Minor units — kobo — so no float ever touches a price. */
  amountMinor: number;
  currency: 'NGN';
  interval: 'month' | 'year';
}

export interface TierDescription {
  tier: BillingTier;
  name: string;
  summary: string;
  includes: string[];
  /** Null for a tier nobody pays for. */
  price: TierPrice | null;
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
    price: null,
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
    // PLACEHOLDER — this number has not been decided. It is here so the price
    // has exactly one home once it is, rather than being written into a page.
    // Minor units avoid floating point ever touching money.
    price: {
      amountMinor: 200000, // ₦2,000
      currency: 'NGN',
      interval: 'month',
    },
  },
};
