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

const SYMPTOM_FALLBACK: SymptomResponse = {
  severity: 'moderate',
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
 *     description: |
 *       Analyzes user-reported symptoms using AI and returns non-diagnostic general guidance.
 *
 *       Safety rules:
 *       - This does not provide diagnosis or prescriptions.
 *       - Users should consult a qualified healthcare professional.
 *       - If AI fails or returns unusable output, the API returns a safe fallback response.
 *       - Daily quota is enforced before the AI request.
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
 *                 minLength: 3
 *                 maxLength: 1000
 *                 example: I have had a headache and mild fever for 2 days
 *           examples:
 *             mildSymptoms:
 *               summary: Mild symptoms
 *               value:
 *                 symptomsText: I have had a headache and mild fever for 2 days
 *             urgentSymptoms:
 *               summary: Potentially urgent symptoms
 *               value:
 *                 symptomsText: I have chest pain, shortness of breath, and dizziness
 *     responses:
 *       201:
 *         description: Symptom analysis result created
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Validation error
 *       429:
 *         description: Daily quota exceeded
 */
router.post('/check', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsedRequest = symptomSchema.safeParse(req.body);
    if (!parsedRequest.success) {
      return validationError(res, parsedRequest.error.issues[0].message);
    }

    await quotaService.checkAndIncrement(
      req.user!.sub,
      req.user!.planType,
      'symptomCheck',
    );

    const prompt = `A user reports the following symptoms: "${parsedRequest.data.symptomsText}"

Respond with a JSON object with exactly these fields:
{
  "severity": "low" | "moderate" | "high" | "emergency",
  "summary": "brief summary of the reported symptoms",
  "guidance": "practical general guidance for this situation",
  "disclaimer": "non-diagnostic disclaimer",
  "seekCareIf": ["list", "of", "warning", "signs", "to", "seek", "care"]
}`;

    let aiResponse: SymptomResponse = SYMPTOM_FALLBACK;
    let usedFallback = false;

    try {
      const rawResponse = await geminiProvider.generateText(prompt, SYSTEM_INSTRUCTION);
      const aiParsed = geminiProvider.parseJsonSafe<SymptomResponse>(rawResponse);

      if (
        aiParsed &&
        ['low', 'moderate', 'high', 'emergency'].includes(aiParsed.severity) &&
        aiParsed.summary &&
        aiParsed.guidance &&
        Array.isArray(aiParsed.seekCareIf)
      ) {
        aiResponse = {
          ...aiParsed,
          disclaimer:
            aiParsed.disclaimer ||
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

    const symptomLog = await prisma.symptomLog.create({
      data: {
        userId: req.user!.sub,
        symptomsText: parsedRequest.data.symptomsText,
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
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           example: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           example: 10
 *     responses:
 *       200:
 *         description: Symptom check history
 *       401:
 *         description: Unauthorized
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
      {
        entries,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
      'Symptom history retrieved',
    );
  } catch (err) {
    next(err);
  }
});

export default router;