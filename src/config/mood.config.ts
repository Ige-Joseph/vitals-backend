// ─────────────────────────────────────────────
// Mood & Craving options
// Config-driven — extend here without touching service logic
// ─────────────────────────────────────────────

export const MOOD_OPTIONS = [
  'HAPPY',
  'CALM',
  'ANXIOUS',
  'TIRED',
  'SAD',
  'EMOTIONAL',
  'IRRITABLE',
  'STRESSED',
  'ENERGETIC',
  'OVERWHELMED',
] as const;

export const CRAVING_OPTIONS = [
  'SWEET',
  'SALTY',
  'SPICY',
  'SOUR',
  'COLD_DRINKS',
  'WARM_FOOD',
  'NO_APPETITE',
  'VERY_HUNGRY',
  'NAUSEOUS',
] as const;

export type MoodOption = (typeof MOOD_OPTIONS)[number];
export type CravingOption = (typeof CRAVING_OPTIONS)[number];

// ─────────────────────────────────────────────
// Rule-based insight engine
// Ordered by specificity — first match wins for each combination
// ─────────────────────────────────────────────

interface InsightRule {
  mood?: MoodOption;
  craving?: CravingOption;
  insight: string;
}

const INSIGHT_RULES: InsightRule[] = [
  // Combined rules (most specific — checked first)
  {
    mood: 'TIRED',
    craving: 'NO_APPETITE',
    insight: 'Fatigue and low appetite often go hand in hand. Stay hydrated and try small, frequent meals throughout the day.',
  },
  {
    mood: 'ANXIOUS',
    craving: 'SWEET',
    insight: 'Anxiety can trigger sweet cravings. Try deep breathing exercises and opt for fruits to satisfy the craving in a nourishing way.',
  },
  {
    mood: 'STRESSED',
    craving: 'SALTY',
    insight: 'Stress often drives salty cravings. Take a short walk, drink water, and try nuts or seeds as a healthier salty option.',
  },
  {
    mood: 'EMOTIONAL',
    craving: 'SWEET',
    insight: 'Emotional moments can drive sweet cravings. It is okay to treat yourself gently — pair a small sweet with something nourishing.',
  },
  {
    mood: 'TIRED',
    craving: 'COLD_DRINKS',
    insight: 'Feeling tired and craving cold drinks may be a sign of dehydration. Try water with a slice of lemon for a refreshing boost.',
  },

  // Mood-only rules
  { mood: 'HAPPY', insight: 'Great to hear you are feeling good today. Keep up the positive energy — you are doing wonderfully.' },
  { mood: 'CALM', insight: 'A calm mood is a great foundation for the day. Take a moment to appreciate how you feel right now.' },
  { mood: 'ANXIOUS', insight: 'It is normal to feel anxious. Try light breathing exercises — breathe in for 4 counts, hold for 4, out for 4. Rest when you can.' },
  { mood: 'TIRED', insight: 'Fatigue is very common and your body is working hard. Rest when you can, stay hydrated, and be gentle with yourself.' },
  { mood: 'SAD', insight: 'It is okay to have difficult days. Reach out to someone you trust, or take a quiet moment for yourself. You are not alone.' },
  { mood: 'EMOTIONAL', insight: 'Emotional days are a natural part of the journey. Allow yourself to feel without judgment — your feelings are valid.' },
  { mood: 'IRRITABLE', insight: 'Feeling irritable can be linked to hunger, fatigue, or hormonal shifts. Try a snack, some water, and a few deep breaths.' },
  { mood: 'STRESSED', insight: 'Stress can take a toll on your body. Identify one small thing you can set aside today and give yourself permission to rest.' },
  { mood: 'ENERGETIC', insight: 'Wonderful — use this energy well. Light activity like a short walk can help channel it positively.' },
  { mood: 'OVERWHELMED', insight: 'When overwhelmed, break things into the smallest possible steps. Focus on just the next one thing. You can do this.' },

  // Craving-only rules
  { craving: 'SWEET', insight: 'Sweet cravings are common. Opt for fruits, yoghurt, or a small piece of dark chocolate to satisfy the craving while keeping nutrition on track.' },
  { craving: 'SALTY', insight: 'Salty cravings can signal a need for minerals. Try nuts, seeds, or olives as a nourishing alternative to processed salty snacks.' },
  { craving: 'SPICY', insight: 'Spicy cravings are normal. Listen to your body — if it causes discomfort, try milder options and keep water nearby.' },
  { craving: 'SOUR', insight: 'Sour cravings are very common, especially in early pregnancy. Citrus fruits are a great option.' },
  { craving: 'COLD_DRINKS', insight: 'Craving cold drinks often means your body wants hydration. Water, coconut water, or a cold herbal tea are great choices.' },
  { craving: 'WARM_FOOD', insight: 'Wanting warm food is comforting and nurturing. A warm soup or stew can be very nourishing right now.' },
  { craving: 'NO_APPETITE', insight: 'Low appetite can happen for many reasons. Try small, frequent meals that are easy to digest. Stay hydrated and rest.' },
  { craving: 'VERY_HUNGRY', insight: 'Increased hunger is a sign your body has high energy needs. Focus on balanced meals with protein, healthy fats, and complex carbs.' },
  { craving: 'NAUSEOUS', insight: 'Nausea can make eating difficult. Try plain crackers, ginger tea, or small bland meals. Eating before getting out of bed can also help.' },
];

const FALLBACK_INSIGHT = 'Thank you for logging today. Tracking your mood and cravings helps you understand your patterns and take better care of yourself.';

/**
 * Deterministic insight engine — no AI, instant, cost-free.
 * Returns the most specific matching insight for the given combination.
 */
export const generateInsight = (mood?: MoodOption, craving?: CravingOption): string => {
  // Check combined rules first (most specific)
  if (mood && craving) {
    const combined = INSIGHT_RULES.find((r) => r.mood === mood && r.craving === craving);
    if (combined) return combined.insight;
  }

  // Mood-only match
  if (mood) {
    const moodRule = INSIGHT_RULES.find((r) => r.mood === mood && !r.craving);
    if (moodRule) return moodRule.insight;
  }

  // Craving-only match
  if (craving) {
    const cravingRule = INSIGHT_RULES.find((r) => r.craving === craving && !r.mood);
    if (cravingRule) return cravingRule.insight;
  }

  return FALLBACK_INSIGHT;
};
