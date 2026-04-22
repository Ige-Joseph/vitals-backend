import {
  getWeekFromLMP,
  getEDD,
  getTrimester,
  getLMPFromWeek,
  getRemainingANCMilestones,
  getGuidanceForWeek,
  ANC_MILESTONES,
} from '@/config/pregnancy.config';

describe('Pregnancy config utilities', () => {
  describe('getTrimester', () => {
    it('returns 1 for weeks 1-13', () => {
      expect(getTrimester(1)).toBe(1);
      expect(getTrimester(8)).toBe(1);
      expect(getTrimester(13)).toBe(1);
    });

    it('returns 2 for weeks 14-26', () => {
      expect(getTrimester(14)).toBe(2);
      expect(getTrimester(20)).toBe(2);
      expect(getTrimester(26)).toBe(2);
    });

    it('returns 3 for weeks 27+', () => {
      expect(getTrimester(27)).toBe(3);
      expect(getTrimester(36)).toBe(3);
      expect(getTrimester(42)).toBe(3);
    });
  });

  describe('getEDD', () => {
    it('returns LMP + 280 days', () => {
      const lmp = new Date('2024-01-01');
      const edd = getEDD(lmp);
      const diffDays = Math.round(
        (edd.getTime() - lmp.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(280);
    });
  });

  describe('getWeekFromLMP', () => {
    it('returns correct week for a known LMP', () => {
      const lmp = new Date();
      lmp.setDate(lmp.getDate() - 70); // 10 weeks ago
      const week = getWeekFromLMP(lmp);
      expect(week).toBe(10);
    });

    it('returns 0 for today LMP', () => {
      const lmp = new Date();
      const week = getWeekFromLMP(lmp);
      expect(week).toBe(0);
    });
  });

  describe('getLMPFromWeek', () => {
    it('derives a consistent LMP from pregnancy week', () => {
      const lmp = getLMPFromWeek(20);
      const derivedWeek = getWeekFromLMP(lmp);
      expect(derivedWeek).toBe(20);
    });
  });

  describe('getRemainingANCMilestones', () => {
    it('returns all milestones for week 0', () => {
      const remaining = getRemainingANCMilestones(0);
      expect(remaining.length).toBe(ANC_MILESTONES.length);
    });

    it('returns fewer milestones for later weeks', () => {
      const week0 = getRemainingANCMilestones(0);
      const week20 = getRemainingANCMilestones(20);
      expect(week20.length).toBeLessThan(week0.length);
    });

    it('returns empty for week 40+', () => {
      const remaining = getRemainingANCMilestones(41);
      expect(remaining.length).toBe(0);
    });

    it('only returns milestones for future weeks', () => {
      const currentWeek = 24;
      const remaining = getRemainingANCMilestones(currentWeek);
      remaining.forEach((m) => expect(m.weekNumber).toBeGreaterThan(currentWeek));
    });
  });

  describe('getGuidanceForWeek', () => {
    it('returns first trimester guidance for week 8', () => {
      const guidance = getGuidanceForWeek(8);
      expect(guidance?.trimester).toBe(1);
    });

    it('returns second trimester guidance for week 20', () => {
      const guidance = getGuidanceForWeek(20);
      expect(guidance?.trimester).toBe(2);
    });

    it('returns third trimester guidance for week 32', () => {
      const guidance = getGuidanceForWeek(32);
      expect(guidance?.trimester).toBe(3);
    });

    it('returns guidance with tips array', () => {
      const guidance = getGuidanceForWeek(12);
      expect(Array.isArray(guidance?.tips)).toBe(true);
      expect(guidance!.tips.length).toBeGreaterThan(0);
    });
  });

  describe('ANC_MILESTONES', () => {
    it('has 9 milestones', () => {
      expect(ANC_MILESTONES.length).toBe(9);
    });

    it('milestones are in ascending week order', () => {
      const weeks = ANC_MILESTONES.map((m) => m.weekNumber);
      for (let i = 1; i < weeks.length; i++) {
        expect(weeks[i]).toBeGreaterThan(weeks[i - 1]);
      }
    });

    it('all milestones have required fields', () => {
      ANC_MILESTONES.forEach((m) => {
        expect(m.weekNumber).toBeDefined();
        expect(m.title).toBeDefined();
        expect(m.description).toBeDefined();
        expect(m.eventType).toBeDefined();
      });
    });
  });
});
