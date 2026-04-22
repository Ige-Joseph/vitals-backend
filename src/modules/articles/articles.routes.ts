import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { articlesService } from './articles.service';
import { authenticate, requireAdmin, optionalAuth } from '@/middleware/auth.middleware';
import { ok, created, validationError } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';

const router = Router();

const VALID_CATEGORIES = [
  'GENERAL',
  'PREGNANCY',
  'BABY_CARE',
  'MEDICATION',
  'NUTRITION',
  'MENTAL_HEALTH',
] as const;

const createArticleSchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters').max(300),
  excerpt: z.string().min(10).max(500),
  content: z.string().min(50, 'Content must be at least 50 characters'),
  imageUrl: z.string().url().optional(),
  category: z.enum(VALID_CATEGORIES),
  slug: z.string().max(120).optional(),
  isPublished: z.boolean().optional().default(false),
});

const updateArticleSchema = createArticleSchema.partial();

// ─── Public routes ─────────────────────────────────────────────────────

/**
 * @swagger
 * /articles:
 *   get:
 *     tags: [Articles]
 *     summary: Fetch published article list
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [GENERAL, PREGNANCY, BABY_CARE, MEDICATION, NUTRITION, MENTAL_HEALTH]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Paginated article list
 */
router.get('/', optionalAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 10);
    const { category } = req.query as { category?: string };

    const data = await articlesService.list({ category, page, limit });
    return ok(res, data, 'Articles retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /articles/{slug}:
 *   get:
 *     tags: [Articles]
 *     summary: Fetch a single published article by slug
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Article content
 *       404:
 *         description: Article not found
 */
router.get('/:slug', optionalAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const slug = req.params.slug as string;
    const article = await articlesService.getBySlug(slug);
    return ok(res, article, 'Article retrieved');
  } catch (err) {
    next(err);
  }
});

// ─── Admin routes ──────────────────────────────────────────────────────

/**
 * @swagger
 * /articles/admin/list:
 *   get:
 *     tags: [Admin]
 *     summary: List all articles including drafts (admin only)
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/admin/list',
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
      const data = await articlesService.adminList({ page, limit });
      return ok(res, data, 'Articles retrieved');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /articles:
 *   post:
 *     tags: [Admin]
 *     summary: Create an article (admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, excerpt, content, category]
 *             properties:
 *               title:
 *                 type: string
 *               excerpt:
 *                 type: string
 *               content:
 *                 type: string
 *               imageUrl:
 *                 type: string
 *               category:
 *                 type: string
 *                 enum: [GENERAL, PREGNANCY, BABY_CARE, MEDICATION, NUTRITION, MENTAL_HEALTH]
 *               isPublished:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Article created
 */
router.post(
  '/',
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = createArticleSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const article = await articlesService.create(parsed.data);
      return created(res, article, 'Article created');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /articles/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Update an article (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Article updated
 */
router.patch(
  '/:id',
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = updateArticleSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const id = req.params.id as string;
      const article = await articlesService.update(id, parsed.data);
      return ok(res, article, 'Article updated');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /articles/{id}:
 *   delete:
 *     tags: [Admin]
 *     summary: Delete an article (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Article deleted
 */
router.delete(
  '/:id',
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const article = await articlesService.delete(id);
      return ok(res, null, 'Article deleted');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
