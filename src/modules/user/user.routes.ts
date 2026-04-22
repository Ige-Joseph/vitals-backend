import { Router } from 'express';
import { userController } from './user.controller';
import { authenticate, requireAdmin } from '@/middleware/auth.middleware';

const router = Router();

// All user routes require authentication
router.use(authenticate);

/**
 * @swagger
 * /users/profile:
 *   get:
 *     tags: [User]
 *     summary: Get current user profile
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile data
 */
router.get('/profile', userController.getProfile);

/**
 * @swagger
 * /users/profile:
 *   patch:
 *     tags: [User]
 *     summary: Update current user profile
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName:
 *                 type: string
 *                 example: Joseph
 *               lastName:
 *                 type: string
 *                 example: Ige
 *               gender:
 *                 type: string
 *                 enum: [MALE, FEMALE, NON_BINARY, PREFER_NOT_TO_SAY]
 *               country:
 *                 type: string
 *                 example: Nigeria
 *               timezone:
 *                 type: string
 *                 example: Africa/Lagos
 *               selectedJourney:
 *                 type: string
 *                 enum: [MEDICATION, PREGNANCY, VACCINATION]
 *               notificationPreferences:
 *                 type: object
 *                 properties:
 *                   pushEnabled:
 *                     type: boolean
 *                   emailEnabled:
 *                     type: boolean
 *                   reminderChannel:
 *                     type: string
 *                     enum: [PUSH, EMAIL, BOTH]
 *     responses:
 *       200:
 *         description: Profile updated
 */
router.patch('/profile', userController.updateProfile);

// ─── Admin routes ──────────────────────────────────────────────────────

/**
 * @swagger
 * /users:
 *   get:
 *     tags: [Admin]
 *     summary: List all users (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
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
 *         description: Paginated user list
 */
router.get('/', requireAdmin, userController.listUsers);

/**
 * @swagger
 * /users/{userId}/deactivate:
 *   patch:
 *     tags: [Admin]
 *     summary: Deactivate a user account (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User deactivated
 */
router.patch('/:userId/deactivate', requireAdmin, userController.deactivateUser);

/**
 * @swagger
 * /users/{userId}/reactivate:
 *   patch:
 *     tags: [Admin]
 *     summary: Reactivate a user account (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User reactivated
 */
router.patch('/:userId/reactivate', requireAdmin, userController.reactivateUser);

export default router;
