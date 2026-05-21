import type { Role, PlanType } from '@prisma/client';

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      role: Role;
      planType: PlanType;
    }

    interface Request {
      user?: User;
    }
  }
}

export {};