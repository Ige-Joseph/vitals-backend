import { Router } from 'express';
import { healthController } from './health.controller';

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: API and dependency health check
 *     security: []
 *     responses:
 *       200:
 *         description: All systems healthy
 *       503:
 *         description: One or more dependencies unavailable
 */
router.get('/', healthController.check);

export default router;
