/**
 * Repair medication doses materialised under server-local time.
 *
 *   npm run reconcile:medication-schedules -- --dry-run
 *   npm run reconcile:medication-schedules -- --dry-run --plan=<carePlanId>
 *   npm run reconcile:medication-schedules -- --apply
 *
 * Dry run is the default. Writing requires `--apply` explicitly, so the
 * dangerous mode is never the one you get by forgetting a flag.
 *
 * Scope is fixed in code, not by argument: active MEDICATION plans, events of
 * type MEDICATION_DOSE, status PENDING, scheduled in the future. Nothing else
 * is loaded, so nothing else can be touched — no history, no DONE, SKIPPED,
 * MISSED or CANCELLED rows, no ANC, no vaccinations, no appointments.
 *
 * Logging names ids, a medication name and timestamps. It deliberately does
 * not print dosage, instructions or anything about the person beyond the ids
 * needed to audit the operation.
 */

import { prisma } from '@/lib/prisma';
import { runReconciliation } from '@/modules/medications/schedule-reconciliation';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=') || undefined;
};

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const iso = (date: Date): string => date.toISOString();

const main = async () => {
  const apply = flag('apply');
  const dryRun = !apply;
  const carePlanId = arg('plan');
  const verbose = flag('verbose');

  if (apply && flag('dry-run')) {
    console.error('Pass either --dry-run or --apply, not both.');
    process.exitCode = 2;
    return;
  }

  console.log('');
  console.log(`Medication schedule reconciliation — ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  if (carePlanId) console.log(`Restricted to care plan ${carePlanId}`);
  console.log('');

  const report = await runReconciliation({ dryRun, carePlanId });

  console.log(`  eligible plans .................. ${report.eligiblePlans}`);
  console.log(`  eligible future pending events .. ${report.eligibleEvents}`);
  console.log(`  events that would change ........ ${report.eventsChanged}`);
  console.log(`  events already correct .......... ${report.eventsAlreadyCorrect}`);
  console.log(`  reminders affected .............. ${report.remindersChanged}`);
  console.log(`  events skipped (unmatched) ...... ${report.skipped.length}`);
  console.log(`  synced calendar entries stale ... ${report.calendarLinksNeedingResync}`);
  console.log('');

  if (report.skipped.length > 0) {
    console.log('  Skipped — these were NOT modified:');
    const byReason = new Map<string, number>();
    for (const item of report.skipped) {
      byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) {
      console.log(`    ${reason}: ${count}`);
    }
    for (const item of report.skipped.slice(0, 20)) {
      console.log(`      event ${item.careEventId} (plan ${item.carePlanId}) — ${item.reason}`);
    }
    console.log('');
  }

  if (report.plansWithCalendarLinks.length > 0) {
    console.log('  Google Calendar entries for these plans will still show the old');
    console.log('  time. There is no update path in the calendar provider — only');
    console.log('  create and delete — so correcting them means running the existing');
    console.log('  cleanup then sync endpoints for each plan, which needs a live');
    console.log('  Google grant. This script deliberately does not do it.');
    for (const planId of report.plansWithCalendarLinks) {
      console.log(`    care plan ${planId}`);
    }
    console.log('');
  }

  if (verbose || dryRun) {
    const changing = report.entries.filter(
      (entry) => entry.changes || entry.reminders.some((r) => r.changes),
    );

    if (changing.length > 0) {
      console.log('  Per-event detail:');
      for (const entry of changing.slice(0, verbose ? changing.length : 50)) {
        console.log(
          `    plan ${entry.carePlanId} · event ${entry.careEventId} · ${entry.medicationName}`,
        );
        console.log(
          `      occurrence ${entry.occurrenceKey}  tz ${entry.timeZone}`,
        );
        console.log(
          `      scheduledFor ${iso(entry.currentScheduledFor)} -> ${iso(entry.targetScheduledFor)}`,
        );
        for (const reminder of entry.reminders) {
          console.log(
            `      reminder ${reminder.reminderId} lead ${reminder.leadMinutes}m  ` +
              `${iso(reminder.currentSendAt)} -> ${iso(reminder.targetSendAt)}` +
              `${reminder.changes ? '' : '  (unchanged)'}`,
          );
        }
      }

      if (!verbose && changing.length > 50) {
        console.log(`    … ${changing.length - 50} more (pass --verbose for all)`);
      }
      console.log('');
    }
  }

  if (dryRun) {
    console.log('  No writes were performed. Re-run with --apply to commit.');
  } else {
    console.log('  Applied. Re-running is safe and will report zero changes.');
  }
  console.log('');
};

main()
  .catch((error) => {
    console.error('Reconciliation failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
