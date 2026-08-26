import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';

import { authenticate } from '@/middleware/auth.middleware';
import { AuthenticatedRequest } from '@/types/express';
import { ok, validationError } from '@/lib/response';
import { reportsService } from './reports.service';
import { renderHealthSummary } from './reports.pdf';

const router = Router();

router.use(authenticate);

/**
 * The default window when none is asked for: the last twelve months.
 *
 * Long enough that a summary taken to a visit is worth reading, and bounded so
 * an unqualified request cannot mean "every row this Person has ever written".
 */
const DEFAULT_PERIOD_DAYS = 365;

const summaryQuerySchema = z.object({
  personId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * @swagger
 * /reports/health-summary:
 *   get:
 *     tags: [Reports]
 *     summary: Download a Person's health summary as a PDF
 *     description: |
 *       Streams a PDF summarising what has been recorded in Vitals for one
 *       Person over a period. Nothing is stored: the document is rendered into
 *       the response and no copy is kept anywhere.
 *
 *       Two independent checks apply, both server-side:
 *       - **Membership** decides whose record may be summarised. Read access is
 *         enough — the document copies out what the reader can already see.
 *       - **Entitlement** decides whether the account may generate one at all.
 *         This is a Premium feature; a free account is refused even for its own
 *         record.
 *
 *       The document contains only what the user recorded. No AI-generated
 *       text appears in it, and doses are reported as recorded counts — taken,
 *       skipped, missed, still scheduled — never as a percentage, score or
 *       trend.
 *
 *       That the summary was generated is recorded (who, whose record, when,
 *       what period); the file itself is not.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: personId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Whose record. Defaults to the caller's own Person.
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *         description: Start of the period. Defaults to 365 days ago.
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *         description: End of the period. Defaults to today.
 *     responses:
 *       200:
 *         description: The PDF
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: The period could not be read, or ends before it starts
 *       403:
 *         description: No access to that Person, or the account is not Premium
 *       404:
 *         description: Person not found
 */
router.get(
  '/health-summary',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = summaryQuerySchema.safeParse(req.query);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const end = parsed.data.to ?? new Date();
      const start =
        parsed.data.from ?? new Date(end.getTime() - DEFAULT_PERIOD_DAYS * 86_400_000);

      const summary = await reportsService.buildHealthSummary(
        req.user!.sub,
        parsed.data.personId,
        { start, end },
      );

      // Recorded before a byte is written. A download abandoned halfway still
      // took half a health record out of the system.
      await reportsService.recordGeneration(req.user!.sub, summary.person.id, {
        start,
        end,
      });

      const filename = `vitals-summary-${summary.person.displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}-${end.toISOString().slice(0, 10)}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // A health record must not sit in a shared cache, and must not be served
      // from one to whoever asks next.
      res.setHeader('Cache-Control', 'no-store, private');

      // Straight into the response. Errors raised before this point are still
      // ordinary JSON errors; once the stream starts, the headers are sent and
      // the error handler can no longer produce a body.
      renderHealthSummary(summary, res);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /reports/generations:
 *   get:
 *     tags: [Reports]
 *     summary: When summaries of this Person were generated, and by whom
 *     description: |
 *       The record kept in place of the files. Answers "who has taken a copy of
 *       this Person's history out of the system, and over what period".
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: personId
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Generation history
 *       403:
 *         description: No access to that Person
 */
router.get(
  '/generations',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const personId =
        typeof req.query.personId === 'string' && req.query.personId.length > 0
          ? req.query.personId
          : undefined;

      const generations = await reportsService.listGenerations(req.user!.sub, personId);
      return ok(res, generations, 'Report history retrieved');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
