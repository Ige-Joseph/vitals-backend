import { signupSchema, loginSchema } from '@/modules/auth/auth.validators';

describe('auth validators', () => {
  it('rejects signup without firstName and lastName', () => {
    const result = signupSchema.safeParse({
      email: 'test@example.com',
      password: 'Password1',
    });

    expect(result.success).toBe(false);
  });

  it('accepts valid signup data', () => {
    const result = signupSchema.safeParse({
      firstName: 'Joseph',
      lastName: 'Ige',
      email: 'test@example.com',
      password: 'Password1',
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid login email', () => {
    const result = loginSchema.safeParse({
      email: 'bad-email',
      password: 'Password1',
    });

    expect(result.success).toBe(false);
  });
});