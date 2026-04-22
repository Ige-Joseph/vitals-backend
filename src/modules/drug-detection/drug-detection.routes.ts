import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/middleware/auth.middleware';
import { ok, validationError, badRequest } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';
import { geminiProvider } from '@/providers/ai/gemini.provider';
import { quotaService } from '@/modules/usage/quota.service';
import { createLogger } from '@/lib/logger';

const log = createLogger('drug-detection');
const router = Router();
router.use(authenticate);

// Multer — memory storage, server-side only, 5MB max
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are accepted'));
    }
  },
});

const VISION_SYSTEM = `You are a medicine identification assistant for a health app.
Identify the medication in the image. You must never prescribe or recommend dosages.
Always include a safety disclaimer. Respond ONLY with valid JSON — no markdown, no preamble.`;

interface DrugDetectionResponse {
  drugName: string;
  commonUsage: string;
  sideEffects: string[];
  caution: string;
  disclaimer: string;
  confidence: 'high' | 'moderate' | 'low' | 'unable_to_identify';
}

// Returned when Gemini fails, times out, or cannot read the image
const DRUG_DETECTION_FALLBACK: DrugDetectionResponse = {
  drugName: 'Unknown',
  commonUsage: 'We could not analyze this image clearly right now.',
  sideEffects: [],
  caution:
    'Please try again with a clearer, well-lit image showing the medication label or packaging.',
  disclaimer:
    'We could not analyze this image clearly right now. Please try again with a clearer image or try again later. This information is not a medical diagnosis. If this involves an urgent health concern, please consult a qualified doctor or pharmacist.',
  confidence: 'unable_to_identify',
};

/**
 * @swagger
 * /drug-detection:
 *   post:
 *     tags: [Drug Detection]
 *     summary: Identify a drug from an uploaded image
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [image]
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Drug identification result
 *       429:
 *         description: Daily quota exceeded
 */
router.post(
  '/',
  upload.single('image'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) return badRequest(res, 'Image file is required');

      // Enforce quota before sending to AI
      await quotaService.checkAndIncrement(
        req.user!.sub,
        req.user!.planType,
        'drugDetection',
      );

      const base64 = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype;

      const prompt = `Identify the medicine or drug in this image. 
Respond with a JSON object with exactly these fields:
{
  "drugName": "name of the medication or 'Unknown' if cannot identify",
  "commonUsage": "what this medication is commonly used for",
  "sideEffects": ["list", "of", "common", "side", "effects"],
  "caution": "important safety caution",
  "disclaimer": "reminder to consult a pharmacist or doctor",
  "confidence": "high" | "moderate" | "low" | "unable_to_identify"
}`;

      // Attempt Gemini vision call — fall back gracefully on any failure
      let aiResponse: DrugDetectionResponse = DRUG_DETECTION_FALLBACK;
      let usedFallback = false;

      try {
        const rawResponse = await geminiProvider.analyzeImage(base64, mimeType, prompt);
        const parsed = geminiProvider.parseJsonSafe<DrugDetectionResponse>(rawResponse);

        if (parsed && parsed.drugName && parsed.confidence) {
          // Ensure disclaimer is always present
          aiResponse = {
            ...parsed,
            disclaimer:
              parsed.disclaimer ||
              'This is general information only and not a medical diagnosis. Always consult a qualified pharmacist or doctor.',
          };
        } else {
          usedFallback = true;
          log.warn('Gemini drug detection response missing required fields — using fallback', {
            userId: req.user!.sub,
          });
        }
      } catch (aiErr: any) {
        usedFallback = true;
        log.warn('Gemini vision call failed — using fallback', {
          userId: req.user!.sub,
          error: aiErr.message,
        });
      }

      const detection = await prisma.drugDetection.create({
        data: {
          userId: req.user!.sub,
          imageUrl: 'local-upload', // Replace with Cloudinary URL when integrated
          detectedDrug: aiResponse.drugName,
          aiResponse: { ...aiResponse, _fallback: usedFallback } as any,
        },
      });

      log.info('Drug detection completed', {
        userId: req.user!.sub,
        drug: aiResponse.drugName,
        confidence: aiResponse.confidence,
        usedFallback,
        detectionId: detection.id,
      });

      return ok(res, { id: detection.id, ...aiResponse }, 'Drug detection complete');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /drug-detection/history:
 *   get:
 *     tags: [Drug Detection]
 *     summary: Fetch previous drug detections
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Detection history
 */
router.get('/history', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 10);

    const [entries, total] = await Promise.all([
      prisma.drugDetection.findMany({
        where: { userId: req.user!.sub },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          detectedDrug: true,
          aiResponse: true,
          createdAt: true,
        },
      }),
      prisma.drugDetection.count({ where: { userId: req.user!.sub } }),
    ]);

    return ok(
      res,
      { entries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
      'Detection history retrieved',
    );
  } catch (err) {
    next(err);
  }
});

export default router;
