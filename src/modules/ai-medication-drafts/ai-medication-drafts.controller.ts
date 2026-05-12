import { Response, NextFunction } from 'express';

import { ok, created, validationError } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';
import { aiMedicationDraftsService } from './ai-medication-drafts.service';
import {
  createTextMedicationDraftSchema,
  updateMedicationDraftSchema,
  draftIdParamSchema,
} from './ai-medication-drafts.validators';

export const aiMedicationDraftsController = {
  async createFromText(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const parsed = createTextMedicationDraftSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0].message);
      }

      const result = await aiMedicationDraftsService.createFromText(
        req.user!.sub,
        parsed.data.message,
      );

      return created(res, result, 'Medication draft generated');
    } catch (err) {
      next(err);
    }
  },

    async createFromAudio(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
    ) {
    try {
        if (!req.file) {
        return validationError(res, 'Audio file is required');
        }

        const result = await aiMedicationDraftsService.createFromAudio(
        req.user!.sub,
        req.file,
        );

        return created(res, result, 'Medication draft generated from audio');
    } catch (err) {
        next(err);
    }
    },

  async updateFromText(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const params = draftIdParamSchema.safeParse(req.params);
      if (!params.success) {
        return validationError(res, params.error.issues[0].message);
      }

      const body = updateMedicationDraftSchema.safeParse(req.body);
      if (!body.success) {
        return validationError(res, body.error.issues[0].message);
      }

      const result = await aiMedicationDraftsService.updateFromText(
        req.user!.sub,
        params.data.id,
        body.data.message,
      );

      return ok(res, result, 'Medication draft updated');
    } catch (err) {
      next(err);
    }
  },

  async getDraft(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const params = draftIdParamSchema.safeParse(req.params);
      if (!params.success) {
        return validationError(res, params.error.issues[0].message);
      }

      const result = await aiMedicationDraftsService.getDraft(
        req.user!.sub,
        params.data.id,
      );

      return ok(res, result, 'Medication draft retrieved');
    } catch (err) {
      next(err);
    }
  },

  async cancelDraft(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const params = draftIdParamSchema.safeParse(req.params);
      if (!params.success) {
        return validationError(res, params.error.issues[0].message);
      }

      const result = await aiMedicationDraftsService.cancelDraft(
        req.user!.sub,
        params.data.id,
      );

      return ok(res, result, 'Medication draft cancelled');
    } catch (err) {
      next(err);
    }
  },


  
};