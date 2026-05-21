import { Request, Response, NextFunction } from 'express';
import { AppError } from '@/lib/errors';
import { AuthenticatedRequest } from '@/types/express';
import { calendarService } from './calendar.service';
import { env } from '@/config/env';

export const calendarController = {
  async syncCarePlan(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      if (!req.user?.sub) {
        throw AppError.unauthorized('Authentication required');
      }

      const userId = req.user.sub;
      const carePlanId = String(req.params.carePlanId);

      const result = await calendarService.prepareCarePlanSync(userId, carePlanId);

      return res.status(200).json({
        success: true,
        message: 'Calendar sync prepared',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },


  async connectGoogle(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user?.sub) throw AppError.unauthorized('Authentication required');

    const result = calendarService.getGoogleConnectUrl(req.user.sub);

    return res.status(200).json({
      success: true,
      message: 'Google Calendar connect URL generated',
      data: result,
    });
  } catch (error) {
    next(error);
  }
},

async googleCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');

    if (!code || !state) {
      throw AppError.badRequest('Missing Google OAuth code or state');
    }


    await calendarService.handleGoogleCallback(code, state);

    return res.redirect(
     `${env.FRONTEND_URL}/profile?calendar=connected`
    );
  } catch (error) {
    next(error);
  }
},



async cleanupCarePlan(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user?.sub) throw AppError.unauthorized('Authentication required');

    const result = await calendarService.cleanupCarePlanEvents(
      req.user.sub,
      String(req.params.carePlanId),
    );

    return res.status(200).json({
      success: true,
      message: 'Calendar cleanup completed',
      data: result,
    });
  } catch (error) {
    next(error);
  }
},



async getSyncSummary(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user?.sub) throw AppError.unauthorized('Authentication required');

    const result = await calendarService.getCalendarSyncSummary(req.user.sub);

    return res.status(200).json({
      success: true,
      message: 'Calendar sync summary retrieved',
      data: result,
    });
  } catch (error) {
    next(error);
  }
},

async retryFailedSyncs(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user?.sub) throw AppError.unauthorized('Authentication required');

    const result = await calendarService.retryFailedSyncs(req.user.sub);

    return res.status(200).json({
      success: true,
      message: 'Calendar retry completed',
      data: result,
    });
  } catch (error) {
    next(error);
  }
},

};