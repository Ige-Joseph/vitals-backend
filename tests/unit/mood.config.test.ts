import { generateInsight } from '@/config/mood.config';

describe('generateInsight', () => {
  it('returns a combined insight for matching mood+craving pair', () => {
    const result = generateInsight('TIRED', 'NO_APPETITE');
    expect(result.toLowerCase()).toContain('fatigue');
  });

  it('returns a mood-only insight when no craving is given', () => {
    const result = generateInsight('ANXIOUS', undefined);
    expect(result.toLowerCase()).toContain('anxious');
  });

  it('returns a craving-only insight when no mood is given', () => {
    const result = generateInsight(undefined, 'SWEET');
    expect(result.toLowerCase()).toContain('sweet');
  });

  it('returns fallback insight when no input is given', () => {
    const result = generateInsight(undefined, undefined);
    expect(result.length).toBeGreaterThan(10);
  });

  it('prefers combined rule over mood-only when both match', () => {
    const combined = generateInsight('ANXIOUS', 'SWEET');
    const moodOnly = generateInsight('ANXIOUS', undefined);
    // Combined rule should differ from mood-only rule
    expect(combined).not.toBe(moodOnly);
  });

  it('returns a string for every mood option', () => {
    const moods = ['HAPPY', 'CALM', 'ANXIOUS', 'TIRED', 'SAD', 'EMOTIONAL', 'IRRITABLE', 'STRESSED', 'ENERGETIC', 'OVERWHELMED'] as const;
    moods.forEach((mood) => {
      const result = generateInsight(mood, undefined);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(10);
    });
  });

  it('returns a string for every craving option', () => {
    const cravings = ['SWEET', 'SALTY', 'SPICY', 'SOUR', 'COLD_DRINKS', 'WARM_FOOD', 'NO_APPETITE', 'VERY_HUNGRY', 'NAUSEOUS'] as const;
    cravings.forEach((craving) => {
      const result = generateInsight(undefined, craving);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(10);
    });
  });
});
