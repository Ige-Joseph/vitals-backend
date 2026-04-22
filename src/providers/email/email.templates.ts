import { env } from '@/config/env';

export const emailTemplates = {
  verification(verificationUrl: string, userName?: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Verify your email</title>
</head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#1a7f64;padding:32px 40px;">
              <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Vitals</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px;color:#111;font-size:20px;">Verify your email address</h2>
              <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
                ${userName ? `Hi ${userName},<br/><br/>` : ''}
                Thank you for signing up for Vitals. Please verify your email address by clicking the button below.
              </p>
              <a href="${verificationUrl}"
                style="display:inline-block;background:#1a7f64;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;">
                Verify email address
              </a>
              <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.6;">
                This link expires in 24 hours. If you did not create a Vitals account, you can safely ignore this email.
              </p>
              <p style="margin:16px 0 0;color:#aaa;font-size:12px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${verificationUrl}" style="color:#1a7f64;word-break:break-all;">${verificationUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px;background:#f9f9f9;border-top:1px solid #eee;">
              <p style="margin:0;color:#aaa;font-size:12px;">
                &copy; ${new Date().getFullYear()} Vitals. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  },

  medicationFallback(medicationName: string, scheduledFor: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Medication reminder</title>
</head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#1a7f64;padding:32px 40px;">
              <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Vitals</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px;color:#111;font-size:20px;">Medication reminder</h2>
              <p style="margin:0 0 16px;color:#555;font-size:15px;line-height:1.6;">
                This is a reminder that you have a pending dose of <strong>${medicationName}</strong>
                that was scheduled for <strong>${scheduledFor}</strong>.
              </p>
              <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
                Please take your medication and mark it as taken in the Vitals app.
              </p>
              <a href="${env.FRONTEND_URL}/care"
                style="display:inline-block;background:#1a7f64;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;">
                Open Vitals
              </a>
              <p style="margin:24px 0 0;color:#aaa;font-size:12px;">
                You are receiving this because you have medication reminders enabled in your Vitals account.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px;background:#f9f9f9;border-top:1px solid #eee;">
              <p style="margin:0;color:#aaa;font-size:12px;">
                &copy; ${new Date().getFullYear()} Vitals. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  },


  passwordReset(resetUrl: string, userName?: string): string {
      return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Password reset</title>
    </head>
    <body style="margin:0;padding:0;background:#f9f9f9;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center" style="padding:40px 0;">
            <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
              
              <!-- Header -->
              <tr>
                <td style="background:#1a7f64;padding:32px 40px;">
                  <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Vitals</h1>
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:40px;">
                  <h2 style="margin:0 0 16px;color:#111;font-size:20px;">Reset your password</h2>

                  <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
                    ${userName ? `Hi ${userName},<br/><br/>` : ''}
                    You requested to reset your password. Click the button below to continue.
                  </p>

                  <a href="${resetUrl}"
                    style="display:inline-block;background:#1a7f64;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;">
                    Reset password
                  </a>

                  <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.6;">
                    This link will expire soon. If you did not request a password reset, you can safely ignore this email.
                  </p>

                  <p style="margin:16px 0 0;color:#aaa;font-size:12px;">
                    If the button doesn't work, copy and paste this link into your browser:<br/>
                    <a href="${resetUrl}" style="color:#1a7f64;word-break:break-all;">${resetUrl}</a>
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="padding:24px 40px;background:#f9f9f9;border-top:1px solid #eee;">
                  <p style="margin:0;color:#aaa;font-size:12px;">
                    &copy; ${new Date().getFullYear()} Vitals. All rights reserved.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>`;
    }

};
