import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';

import { authenticate } from '@/middleware/auth.middleware';
import { AuthenticatedRequest } from '@/types/express';
import { ok, accepted, validationError } from '@/lib/response';
import { createLogger } from '@/lib/logger';
import { reportsService } from './reports.service';
import { renderHealthSummary } from './reports.pdf';

const log = createLogger('reports-routes');

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

/** Same three fields, taken from a JSON body rather than the query string. */
const summaryRequestSchema = summaryQuerySchema;

/**
 * @swagger
 * /reports/health-summary:
 *   get:
 *     tags: [Reports]
 *     summary: (Deprecated) Download a Person's health summary as a PDF
 *     deprecated: true
 *     description: |
 *       **Deprecated — use `POST /reports/health-summary` instead.**
 *
 *       Renders the document inside the request and streams it back. It still
 *       works and still behaves exactly as it always has, so existing clients
 *       are not broken; it is kept only while they migrate.
 *
 *       Prefer the asynchronous flow. Rendering shares a Node process with the
 *       API, so a summary produced this way competes with every other request
 *       for the same event loop. `POST` returns immediately and the worker
 *       renders one document at a time.
 *
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

/**
 * @swagger
 * /reports/health-summary:
 *   post:
 *     tags: [Reports]
 *     summary: Ask for a Person's health summary
 *     description: |
 *       Accepts the request and returns immediately with `202`. The document is
 *       rendered by a worker; poll `GET /reports/health-summary/{id}` until
 *       `status` is `READY`, then fetch the file from the `/download` route.
 *
 *       Two independent checks apply here and again on every download, both
 *       server-side:
 *       - **Membership** decides whose record may be summarised. Read access is
 *         enough — the document copies out what the reader can already see.
 *       - **Entitlement** decides whether the account may generate one at all.
 *         This is a Premium feature; a free account is refused even for its own
 *         record.
 *
 *       Access is checked first, so a caller with no relationship to a Person
 *       is told that rather than invited to upgrade.
 *
 *       **The document expires.** `expiresAt` is set when rendering finishes,
 *       after which the file is deleted and the download answers `410`. The
 *       record that a summary was generated outlives the file deliberately.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               personId:
 *                 type: string
 *                 format: uuid
 *                 description: Whose record. Defaults to the caller's own Person.
 *               from:
 *                 type: string
 *                 format: date
 *                 description: Start of the period. Defaults to 365 days ago.
 *               to:
 *                 type: string
 *                 format: date
 *                 description: End of the period. Defaults to today.
 *     responses:
 *       202:
 *         description: Accepted. Rendering has been queued.
 *       400:
 *         description: The period could not be read, or ends before it starts
 *       403:
 *         description: No access to that Person, or the account is not Premium
 *       404:
 *         description: Person not found
 */
router.post(
  '/health-summary',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = summaryRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const end = parsed.data.to ?? new Date();
      const start =
        parsed.data.from ?? new Date(end.getTime() - DEFAULT_PERIOD_DAYS * 86_400_000);

      const generation = await reportsService.requestHealthSummary(
        req.user!.sub,
        parsed.data.personId,
        { start, end },
      );

      return accepted(res, generation, 'Your summary is being prepared');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /reports/health-summary/{id}:
 *   get:
 *     tags: [Reports]
 *     summary: Whether a requested summary is ready
 *     description: |
 *       `status` moves `PENDING` → `PROCESSING` → `READY`, or to `FAILED` with
 *       a `failureReason`. A `READY` document becomes `EXPIRED` once its
 *       `expiresAt` passes and the file is swept.
 *
 *       Poll this on a bounded schedule rather than indefinitely. Access is
 *       resolved through membership on the Person the summary is about, so
 *       anyone who can read that Person can see that a summary was taken.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: The generation's current state
 *       403:
 *         description: No access to that Person
 *       404:
 *         description: No such report
 */
router.get(
  '/health-summary/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const generation = await reportsService.generationStatus(
        req.user!.sub,
        String(req.params.id),
      );
      return ok(res, generation, 'Report status retrieved');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /reports/health-summary/{id}/download:
 *   get:
 *     tags: [Reports]
 *     summary: Download a prepared health summary
 *     description: |
 *       **Streams a file. It does not return the JSON envelope.** Errors still
 *       do, so check the status and content type before treating the body as a
 *       PDF.
 *
 *       Membership and entitlement are both re-checked here, on every request.
 *       Having asked for the document earns nothing: access revoked, or Premium
 *       lapsed, between generating and fetching stops the download. This is why
 *       there is no signed URL — such a URL keeps working after the membership
 *       that justified it is gone.
 *
 *       `410` means the document expired and was deleted. It is not an error in
 *       the usual sense: ask for another one.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: The PDF
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Still being prepared, or rendering failed
 *       403:
 *         description: No access to that Person, or the account is not Premium
 *       404:
 *         description: No such report
 *       410:
 *         description: The document expired and was deleted
 */
router.get(
  '/health-summary/:id/download',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { stream, filename, sizeBytes } = await reportsService.prepareDownload(
        req.user!.sub,
        String(req.params.id),
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(sizeBytes));
      // A health record must not sit in a shared cache, and must not be served
      // from one to whoever asks next.
      res.setHeader('Cache-Control', 'no-store, private');

      // Once bytes start flowing the headers are sent and the error handler can
      // no longer produce a body, so a read failure here can only be logged and
      // the connection dropped.
      stream.on('error', (err) => {
        log.error('Report download stream failed', {
          reportGenerationId: String(req.params.id),
          error: err.message,
        });
        res.destroy(err);
      });

      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
