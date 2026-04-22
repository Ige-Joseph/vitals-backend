import axios from 'axios';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('brevo-adapter');

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

class BrevoAdapter {
  async send(options: SendEmailOptions): Promise<void> {
    try {
      const response = await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: {
            name: env.BREVO_FROM_NAME,
            email: env.BREVO_FROM_EMAIL,
          },
          to: [{ email: options.to }],
          subject: options.subject,
          htmlContent: options.html,
          textContent: options.text ?? options.html.replace(/<[^>]*>/g, ''),
        },
        {
          headers: {
            'api-key': env.BREVO_API_KEY,
            'Content-Type': 'application/json',
          },
        },
      );

      log.info('Email sent', {
        to: options.to,
        subject: options.subject,
        messageId: response.data?.messageId,
      });
    } catch (err: any) {
      log.error('Email send failed', {
        to: options.to,
        subject: options.subject,
        error: err.response?.data || err.message,
      });
      throw err;
    }
  }

  async verify(): Promise<boolean> {
    try {
      await axios.get('https://api.brevo.com/v3/account', {
        headers: {
          'api-key': env.BREVO_API_KEY,
        },
      });
      return true;
    } catch {
      return false;
    }
  }
}

export const brevoAdapter = new BrevoAdapter();