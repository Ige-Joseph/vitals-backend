import { Request } from 'express';
import { AccessTokenPayload } from '@/lib/jwt';

export interface AuthenticatedRequest extends Request {
  user?: AccessTokenPayload;
}
