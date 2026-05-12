import { Router } from 'express';

import { authenticate } from '@/middleware/auth.middleware';
import { aiMedicationDraftsController } from './ai-medication-drafts.controller';
import { audioUpload } from '@/middleware/audio-upload.middleware';



const router = Router();

router.use(authenticate);

/**
 * @swagger
 * /ai/medication-drafts/text:
 *   post:
 *     tags: [AI Medication Drafts]
 *     summary: Generate medication draft from text
 *     description: Converts a user medication instruction into a temporary editable medication draft. This does not create a real medication plan.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message:
 *                 type: string
 *                 example: Remind me to take Paracetamol 500mg twice daily for 5 days after food
 *     responses:
 *       201:
 *         description: Medication draft generated
 */
router.post('/text', aiMedicationDraftsController.createFromText);



/**
 * @swagger
 * /ai/medication-drafts/audio:
 *   post:
 *     tags: [AI Medication Drafts]
 *     summary: Generate medication draft from audio
 *     description: Upload an audio recording containing medication instructions.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - audio
 *             properties:
 *               audio:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Medication draft generated from audio
 */
router.post(
  '/audio',
  audioUpload.single('audio'),
  aiMedicationDraftsController.createFromAudio,
);



/**
 * @swagger
 * /ai/medication-drafts/{id}:
 *   patch:
 *     tags: [AI Medication Drafts]
 *     summary: Update an existing medication draft
 *     description: Adds more user-provided information to an incomplete AI medication draft.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 4fd9d4c7-6e33-4a7f-9fc5-0d6d1fd5a912
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message:
 *                 type: string
 *                 example: 500mg for 5 days
 *     responses:
 *       200:
 *         description: Medication draft updated
 */
router.patch('/:id', aiMedicationDraftsController.updateFromText);

/**
 * @swagger
 * /ai/medication-drafts/{id}:
 *   get:
 *     tags: [AI Medication Drafts]
 *     summary: Get a medication draft
 *     description: Retrieves a temporary AI medication draft for the authenticated user.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 4fd9d4c7-6e33-4a7f-9fc5-0d6d1fd5a912
 *     responses:
 *       200:
 *         description: Medication draft retrieved
 */
router.get('/:id', aiMedicationDraftsController.getDraft);

/**
 * @swagger
 * /ai/medication-drafts/{id}/cancel:
 *   patch:
 *     tags: [AI Medication Drafts]
 *     summary: Cancel a medication draft
 *     description: Marks an AI medication draft as CANCELLED. Cancelled drafts cannot be updated or used again.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         example: 4fd9d4c7-6e33-4a7f-9fc5-0d6d1fd5a912
 *     responses:
 *       200:
 *         description: Medication draft cancelled
 */
router.patch('/:id/cancel', aiMedicationDraftsController.cancelDraft);





export default router;