import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: {
    sub: string
    email: string
    role: string
    planType: string
  }
  file?: Express.Multer.File
}