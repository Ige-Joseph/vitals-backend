import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = 12;

async function main() {
  console.log('🌱 Seeding database...');

  // ─── Admin user ──────────────────────────────────────────────────────
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@vitals.health';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@Vitals2024';

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);

    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash,
        role: 'ADMIN',
        planType: 'PREMIUM',
        emailVerified: true,
        profile: {
          create: {
            timezone: 'Africa/Lagos',
            notificationPreferences: {},
          },
        },
      },
    });

    console.log(`✅ Admin user created: ${admin.email}`);
  } else {
    console.log(`⏭️  Admin user already exists: ${adminEmail}`);
  }

  // ─── Demo user ───────────────────────────────────────────────────────
  const demoEmail = process.env.SEED_DEMO_EMAIL ?? 'demo@vitals.health';
  const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'Demo@Vitals2024';

  const existingDemo = await prisma.user.findUnique({ where: { email: demoEmail } });

  if (!existingDemo) {
    const passwordHash = await bcrypt.hash(demoPassword, BCRYPT_ROUNDS);

    await prisma.user.create({
      data: {
        email: demoEmail,
        passwordHash,
        role: 'USER',
        planType: 'FREE',
        emailVerified: true,
        profile: {
          create: {
            sex: 'FEMALE',
            timezone: 'Africa/Lagos',
            selectedJourney: 'PREGNANCY',
            notificationPreferences: {},
          },
        },
      },
    });

    console.log(`✅ Demo user created: ${demoEmail}`);
  } else {
    console.log(`⏭️  Demo user already exists: ${demoEmail}`);
  }

  // ─── Sample articles ─────────────────────────────────────────────────
  const articles = [
    {
      title: 'Understanding your first trimester',
      slug: 'understanding-your-first-trimester',
      excerpt: 'The first 13 weeks of pregnancy bring major changes. Here is what to expect and how to take care of yourself.',
      content: `The first trimester spans from week 1 to week 13 of pregnancy. During this period, your baby develops from a single fertilised cell into a fully formed foetus with all major organs in place.

**What to expect**

Many women experience nausea, fatigue, breast tenderness, and frequent urination during the first trimester. These symptoms are caused by the surge in pregnancy hormones and are a normal part of the process.

**Taking care of yourself**

- Take folic acid daily — this reduces the risk of neural tube defects
- Avoid alcohol, smoking, and raw or undercooked food
- Attend your first antenatal care appointment before week 12
- Rest as much as you need — fatigue at this stage is your body doing important work

**When to seek care**

Contact your doctor immediately if you experience heavy bleeding, severe abdominal pain, or fever. These may require prompt attention.`,
      category: 'PREGNANCY' as const,
      isPublished: true,
      imageUrl: null,
    },
    {
      title: 'Essential vaccines for your baby in the first year',
      slug: 'essential-vaccines-first-year',
      excerpt: 'A guide to the key vaccinations your baby needs from birth through 12 months, and why each one matters.',
      content: `Vaccinations are one of the most important things you can do to protect your baby's health. Here is a guide to the key vaccines in the first year of life.

**At birth**

Your baby will receive BCG (protection against tuberculosis), Hepatitis B, and OPV 0 (oral polio vaccine) within 24 hours of birth.

**6 weeks**

At 6 weeks, your baby receives the first doses of DPT-HepB-Hib (combination vaccine), PCV (pneumococcal), Rotavirus, and a second dose of OPV.

**10 and 14 weeks**

These visits repeat the combination vaccines to build lasting immunity. At 14 weeks, your baby also receives IPV (inactivated polio vaccine).

**Why timing matters**

Vaccines are scheduled at specific ages because babies are most vulnerable to certain infections early in life. Missing or delaying vaccines leaves your baby unprotected. Always attend your scheduled vaccination appointments.`,
      category: 'BABY_CARE' as const,
      isPublished: true,
      imageUrl: null,
    },
    {
      title: 'Managing medication adherence with Vitals',
      slug: 'managing-medication-adherence',
      excerpt: 'How to set up a medication plan, use reminders effectively, and track your adherence over time.',
      content: `Medication adherence — taking your medication at the right time and right dose — is one of the most important factors in effective treatment.

**Setting up a medication plan**

In the My Care section, you can create a medication plan by entering the medication name, dosage, frequency, and duration. Vitals will automatically generate a reminder schedule based on your settings.

**Understanding your reminders**

You will receive a push notification at each scheduled dose time. Tap the notification to open the app and mark the dose as taken. If you do not mark it within 30 minutes, you will receive a follow-up email reminder.

**Tracking your adherence**

Your medication history shows each dose — taken, skipped, or missed. Over time, this gives you a clear picture of your adherence patterns, which you can share with your healthcare provider.

**Tips for better adherence**

- Set your medication times to align with existing routines — meals, morning routine, or bedtime
- Keep your medication in a visible location
- Use the notes field for any instructions your doctor gave you`,
      category: 'MEDICATION' as const,
      isPublished: true,
      imageUrl: null,
    },
    {
      title: 'Eating well during pregnancy',
      slug: 'eating-well-during-pregnancy',
      excerpt: 'Practical nutrition guidance for each trimester, including foods to embrace and foods to avoid.',
      content: `Good nutrition during pregnancy supports your baby\'s development and helps you stay healthy through the journey.

**Key nutrients to focus on**

- **Folic acid** — prevents neural tube defects. Found in leafy greens, beans, and fortified foods
- **Iron** — supports healthy blood production. Found in meat, beans, and dark leafy vegetables
- **Calcium** — supports your baby\'s bone development. Found in dairy, tofu, and leafy greens
- **Protein** — essential for foetal growth. Found in meat, fish, eggs, and legumes

**Foods to avoid**

Raw or undercooked meat and eggs, unpasteurised dairy, high-mercury fish (shark, swordfish, king mackerel), alcohol, and excess caffeine (limit to 200mg per day).

**Managing nausea**

Eating small, frequent meals throughout the day can help manage first-trimester nausea. Ginger tea, crackers, and avoiding strong-smelling foods may also help.

**Staying hydrated**

Aim for 8-10 glasses of water per day. Dehydration can cause fatigue and headaches, which are already common in pregnancy.`,
      category: 'NUTRITION' as const,
      isPublished: true,
      imageUrl: null,
    },
    {
      title: 'Managing anxiety during pregnancy',
      slug: 'managing-anxiety-during-pregnancy',
      excerpt: 'It is normal to feel anxious during pregnancy. Here are practical strategies to support your mental wellbeing.',
      content: `Anxiety during pregnancy is common and understandable. You are going through a major life change, and it is natural to have concerns. But when anxiety becomes persistent, it is important to address it.

**Why anxiety is common in pregnancy**

Hormonal changes, physical discomfort, uncertainty about parenthood, and health concerns can all contribute to anxiety. Feeling worried does not mean something is wrong with you.

**Practical strategies**

- **Breathe** — slow, deep breathing activates the parasympathetic nervous system and reduces stress. Try 4-4-4 breathing: inhale for 4 counts, hold for 4, exhale for 4
- **Move** — gentle exercise like walking or prenatal yoga can significantly reduce anxiety
- **Connect** — talk to a trusted friend, partner, or your midwife about how you are feeling
- **Limit information overload** — searching symptoms online can worsen anxiety. Stick to reliable sources and ask your doctor directly

**When to seek help**

If anxiety is affecting your sleep, appetite, or daily functioning, speak to your midwife or doctor. Therapy and other support options are available and safe during pregnancy.

**Using the mood tracker**

Vitals includes a daily mood check-in. Tracking your mood over time can help you identify patterns and share useful context with your healthcare provider.`,
      category: 'MENTAL_HEALTH' as const,
      isPublished: true,
      imageUrl: null,
    },
  ];

  for (const article of articles) {
    const existing = await prisma.article.findUnique({ where: { slug: article.slug } });
    if (!existing) {
      await prisma.article.create({
        data: {
          ...article,
          publishedAt: new Date(),
        },
      });
      console.log(`✅ Article created: ${article.slug}`);
    } else {
      console.log(`⏭️  Article already exists: ${article.slug}`);
    }
  }

  console.log('\n✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
