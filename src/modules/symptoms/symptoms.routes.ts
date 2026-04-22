import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/middleware/auth.middleware';
import { ok, created, validationError } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';
import { geminiProvider } from '@/providers/ai/gemini.provider';
import { quotaService } from '@/modules/usage/quota.service';
import { createLogger } from '@/lib/logger';

const log = createLogger('symptoms');
const router = Router();
router.use(authenticate);

const SYSTEM_INSTRUCTION = `You are a non-diagnostic health information assistant for a maternal and general health app. 
You provide general health information and guidance only — never diagnoses or prescriptions.
Always include a disclaimer that users should consult a healthcare professional.
Respond ONLY with valid JSON — no markdown, no preamble.`;

const symptomSchema = z.object({
  symptomsText: z.string().min(3, 'Please describe your symptoms').max(1000),
});

interface SymptomResponse {
  severity: 'low' | 'moderate' | 'high' | 'emergency';
  summary: string;
  guidance: string;
  disclaimer: string;
  seekCareIf: string[];
}

// Returned when Gemini fails, times out, or returns unusable output
const SYMPTOM_FALLBACK: SymptomResponse = {
  severity: 'low',
  summary: 'We were unable to complete a reliable health assessment right now.',
  guidance:
    'Please try again shortly. If your symptoms feel severe, urgent, or are getting worse, do not wait — visit a qualified doctor or seek immediate medical attention.',
  disclaimer:
    'This information is not a medical diagnosis. Always consult a qualified healthcare professional for personal medical advice.',
  seekCareIf: [
    'Your symptoms are severe or getting rapidly worse',
    'You are experiencing chest pain, difficulty breathing, or loss of consciousness',
    'You are concerned and want professional reassurance',
  ],
};

/**
 * @swagger
 * /symptoms/check:
 *   post:
 *     tags: [Symptoms]
 *     summary: AI-powered symptom check — returns structured guidance
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [symptomsText]
 *             properties:
 *               symptomsText:
 *                 type: string
 *                 example: I have had a headache and mild fever for 2 days
 *     responses:
 *       200:
 *         description: Symptom analysis result
 *       429:
 *         description: Daily quota exceeded
 */
router.post('/check', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = symptomSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    // Enforce quota before calling AI — never trust client
    await quotaService.checkAndIncrement(req.user!.sub, req.user!.planType, 'symptomCheck');

    const prompt = `A user reports the following symptoms: "${parsed.data.symptomsText}"

Respond with a JSON object with exactly these fields:
{
  "severity": "low" | "moderate" | "high" | "emergency",
  "summary": "brief summary of the reported symptoms",
  "guidance": "practical general guidance for this situation",
  "disclaimer": "non-diagnostic disclaimer",
  "seekCareIf": ["list", "of", "warning", "signs", "to", "seek", "care"]
}`;

    // Attempt Gemini call — fall back gracefully on any failure
    let aiResponse: SymptomResponse = SYMPTOM_FALLBACK;
    let usedFallback = false;

    try {
      const rawResponse = await geminiProvider.generateText(prompt, SYSTEM_INSTRUCTION);
      const parsed = geminiProvider.parseJsonSafe<SymptomResponse>(rawResponse);

      if (parsed && parsed.severity && parsed.summary && parsed.guidance) {
        // Ensure disclaimer is always present
        aiResponse = {
          ...parsed,
          disclaimer:
            parsed.disclaimer ||
            'This is general information only and not a medical diagnosis. Please consult a qualified healthcare professional.',
        };
      } else {
        usedFallback = true;
        log.warn('Gemini symptom response missing required fields — using fallback', {
          userId: req.user!.sub,
        });
      }
    } catch (aiErr: any) {
      usedFallback = true;
      log.warn('Gemini symptom call failed — using fallback', {
        userId: req.user!.sub,
        error: aiErr.message,
      });
    }

    // Persist — store fallback indicator in metadata so it's queryable later
    const symptomLog = await prisma.symptomLog.create({
      data: {
        userId: req.user!.sub,
        symptomsText: parsed.data.symptomsText,
        severity: aiResponse.severity,
        aiResponse: { ...aiResponse, _fallback: usedFallback } as any,
      },
    });

    log.info('Symptom check completed', {
      userId: req.user!.sub,
      severity: aiResponse.severity,
      usedFallback,
      logId: symptomLog.id,
    });

    return created(res, { id: symptomLog.id, ...aiResponse }, 'Symptom check complete');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /symptoms/history:
 *   get:
 *     tags: [Symptoms]
 *     summary: Fetch previous symptom checks
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Symptom check history
 */
router.get('/history', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 10);

    const [entries, total] = await Promise.all([
      prisma.symptomLog.findMany({
        where: { userId: req.user!.sub },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          symptomsText: true,
          severity: true,
          aiResponse: true,
          createdAt: true,
        },
      }),
      prisma.symptomLog.count({ where: { userId: req.user!.sub } }),
    ]);

    return ok(
      res,
      { entries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
      'Symptom history retrieved',
    );
  } catch (err) {
    next(err);
  }
});

export default router;
