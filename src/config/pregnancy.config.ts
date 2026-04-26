// ─────────────────────────────────────────────
// Pregnancy domain config
// All milestone and schedule rules live here — never in service logic
// ─────────────────────────────────────────────

export interface ANCMilestone {
  weekNumber: number;
  title: string;
  description: string;
  eventType: string;
}

export interface WeeklyGuidance {
  weekRange: [number, number]; // inclusive
  trimester: 1 | 2 | 3;
  summary: string;
  tips: string[];
}

// WHO-aligned ANC visit schedule
export const ANC_MILESTONES: ANCMilestone[] = [
  {
    weekNumber: 12,
    title: 'First ANC Visit',
    description: 'First antenatal care visit — blood tests, BP, weight, dating scan if not done.',
    eventType: 'ANC_VISIT',
  },
  {
    weekNumber: 16,
    title: 'Second ANC Visit',
    description: 'Blood pressure check, urine test, foetal heartbeat check.',
    eventType: 'ANC_VISIT',
  },
  {
    weekNumber: 20,
    title: 'Anomaly Scan',
    description: '20-week anatomy scan — checks baby\'s development and organ formation.',
    eventType: 'ANC_SCAN',
  },
  {
    weekNumber: 24,
    title: 'Third ANC Visit',
    description: 'Glucose tolerance test, anaemia screening, weight and BP check.',
    eventType: 'ANC_VISIT',
  },
  {
    weekNumber: 28,
    title: 'Fourth ANC Visit',
    description: 'Anti-D injection if Rh negative, full blood count, BP monitoring.',
    eventType: 'ANC_VISIT',
  },
  {
    weekNumber: 32,
    title: 'Fifth ANC Visit',
    description: 'Foetal position assessment, symphysis-fundal height, BP.',
    eventType: 'ANC_VISIT',
  },
  {
    weekNumber: 36,
    title: 'Sixth ANC Visit',
    description: 'Birth plan discussion, Group B Strep test, foetal presentation check.',
    eventType: 'ANC_VISIT',
  },
  {
    weekNumber: 38,
    title: 'Seventh ANC Visit',
    description: 'Cervical check, monitoring for signs of labour, birth readiness review.',
    eventType: 'ANC_VISIT',
  },
  {
    weekNumber: 40,
    title: 'Eighth ANC Visit — Due Date',
    description: 'Post-dates monitoring, induction discussion if not yet in labour.',
    eventType: 'ANC_VISIT',
  },
];

// Baby vaccination schedule — weeks/months after birth
export interface VaccinationMilestone {
  ageLabel: string;        // Human-readable: "At birth", "6 weeks"
  ageWeeks: number;        // Weeks after delivery
  vaccines: string[];
  eventType: string;
}

export const VACCINATION_SCHEDULE: VaccinationMilestone[] = [
  {
    ageLabel: 'At birth',
    ageWeeks: 0,
    vaccines: ['BCG', 'Hepatitis B (birth dose)', 'OPV 0'],
    eventType: 'BABY_VACCINATION',
  },
  {
    ageLabel: '6 weeks',
    ageWeeks: 6,
    vaccines: ['OPV 1', 'DPT-HepB-Hib 1', 'PCV 1', 'Rotavirus 1'],
    eventType: 'BABY_VACCINATION',
  },
  {
    ageLabel: '10 weeks',
    ageWeeks: 10,
    vaccines: ['OPV 2', 'DPT-HepB-Hib 2', 'PCV 2', 'Rotavirus 2'],
    eventType: 'BABY_VACCINATION',
  },
  {
    ageLabel: '14 weeks',
    ageWeeks: 14,
    vaccines: ['OPV 3', 'DPT-HepB-Hib 3', 'PCV 3', 'IPV'],
    eventType: 'BABY_VACCINATION',
  },
  {
    ageLabel: '6 months',
    ageWeeks: 26,
    vaccines: ['Vitamin A (first dose)', 'Meningitis A'],
    eventType: 'BABY_VACCINATION',
  },
  {
    ageLabel: '9 months',
    ageWeeks: 39,
    vaccines: ['Measles-Rubella (MR) 1', 'Yellow Fever', 'Meningitis A booster'],
    eventType: 'BABY_VACCINATION',
  },
  {
    ageLabel: '12 months',
    ageWeeks: 52,
    vaccines: ['Hepatitis A', 'Varicella'],
    eventType: 'BABY_VACCINATION',
  },
  {
    ageLabel: '15 months',
    ageWeeks: 65,
    vaccines: ['Measles-Mumps-Rubella (MMR)', 'PCV booster'],
    eventType: 'BABY_VACCINATION',
  },
  {
    ageLabel: '18 months',
    ageWeeks: 78,
    vaccines: ['DPT booster', 'OPV booster', 'Vitamin A (second dose)'],
    eventType: 'BABY_VACCINATION',
  },
];

// Trimester weekly guidance — drives the timeline endpoint
export const WEEKLY_GUIDANCE: WeeklyGuidance[] = [
  {
    weekRange: [1, 13],
    trimester: 1,
    summary: 'First trimester — your baby is forming all major organs.',
    tips: [
      'Take folic acid daily',
      'Avoid alcohol and smoking',
      'Stay hydrated',
      'Rest when you feel tired — fatigue is normal',
      'Book your first ANC appointment',
    ],
  },
  {
    weekRange: [14, 26],
    trimester: 2,
    summary: 'Second trimester — often the most comfortable stage.',
    tips: [
      'Attend your anomaly scan at 20 weeks',
      'Begin gentle prenatal exercise if cleared by your doctor',
      'Start thinking about your birth plan',
      'Sleep on your side — left side is best for circulation',
      'Eat iron-rich foods to prevent anaemia',
    ],
  },
  {
    weekRange: [27, 42],
    trimester: 3,
    summary: 'Third trimester — your baby is growing rapidly and preparing for birth.',
    tips: [
      'Attend all remaining ANC appointments',
      'Prepare your hospital bag',
      'Learn the signs of labour',
      'Count baby movements daily',
      'Rest as much as possible',
    ],
  },
];

// ─────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────

export const getTrimester = (week: number): 1 | 2 | 3 => {
  if (week <= 13) return 1;
  if (week <= 26) return 2;
  return 3;
};

export const getWeekFromLMP = (lmpDate: Date): number => {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const lmp = new Date(lmpDate);
  lmp.setHours(0, 0, 0, 0);

  const diff = now.getTime() - lmp.getTime();

  const week = Math.floor(diff / msPerWeek) + 1;

  return Math.min(Math.max(week, 1), 42);
};

export const getEDD = (lmpDate: Date): Date => {
  const edd = new Date(lmpDate);
  edd.setDate(edd.getDate() + 280); // Naegele's rule: LMP + 280 days
  return edd;
};

export const getLMPFromWeek = (pregnancyWeek: number): Date => {
  const lmp = new Date();
  lmp.setDate(lmp.getDate() - (pregnancyWeek - 1) * 7);
  return lmp;
};

export const getGuidanceForWeek = (week: number): WeeklyGuidance | undefined =>
  WEEKLY_GUIDANCE.find(
    (g) => week >= g.weekRange[0] && week <= g.weekRange[1],
  );

// Filter ANC milestones to only those not yet passed given current week
export const getRemainingANCMilestones = (currentWeek: number) =>
  ANC_MILESTONES.filter((m) => m.weekNumber >= currentWeek);
