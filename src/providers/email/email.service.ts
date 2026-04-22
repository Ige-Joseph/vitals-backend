import { env } from '@/config/env';
import { brevoAdapter } from './brevo.adapter';
import { emailTemplates } from './email.templates';
import { createLogger } from '@/lib/logger';

const log = createLogger('email-service');

export const emailService = {
  async sendVerificationEmail(options: {
    to: string;
    rawToken: string;
    userName?: string;
  }): Promise<void> {
    const verificationUrl = `${env.FRONTEND_URL}/verify-email?token=${options.rawToken}`;

    await brevoAdapter.send({
      to: options.to,
      subject: 'Verify your Vitals email address',
      html: emailTemplates.verification(verificationUrl, options.userName),
    });

    log.info('Verification email sent', { to: options.to });
  },

  async sendPasswordResetEmail(options: {
    to: string;
    rawToken: string;
    userName?: string;
  }): Promise<void> {
    const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${options.rawToken}`;

    await brevoAdapter.send({
      to: options.to,
      subject: 'Reset your Vitals password',
      html: emailTemplates.passwordReset(resetUrl, options.userName),
    });

    log.info('Password reset email sent', { to: options.to });
  },

  async sendMedicationFallbackEmail(options: {
    to: string;
    medicationName: string;
    scheduledFor: string;
  }): Promise<void> {
    await brevoAdapter.send({
      to: options.to,
      subject: `Reminder: Take your ${options.medicationName}`,
      html: emailTemplates.medicationFallback(
        options.medicationName,
        options.scheduledFor,
      ),
    });

    log.info('Medication fallback email sent', { to: options.to });
  },
};