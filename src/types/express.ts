import { Request } from 'express';
import { AccessTokenPayload } from '@/lib/jwt';

export interface AuthenticatedRequest extends Request {
  user?: {
    sub: string
    email: string
    role: string
    planType: string
  }
  file?: Express.Multer.File
}