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
            <td style="background:#1a73e8;padding:32px 40px;">
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
                style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;">
                Verify email address
              </a>
              <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.6;">
                This link expires in 24 hours. If you did not create a Vitals account, you can safely ignore this email.
              </p>
              <p style="margin:16px 0 0;color:#aaa;font-size:12px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${verificationUrl}" style="color:#1a73e8;word-break:break-all;">${verificationUrl}</a>
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

  /**
   * An invitation to a record. Positioned as an offer of access, never as a
   * statement about anyone's health — the recipient may not have a Vitals
   * account, and this email can land in an inbox other people can see.
   */
  personInvitation(options: {
    acceptUrl: string;
    recordName: string;
    inviterName: string;
    hasAccount: boolean;
  }): string {
    const action = options.hasAccount ? 'Open invitation' : 'Create an account to continue';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>An invitation to Vitals</title>
</head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#1a73e8;padding:32px 40px;">
              <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Vitals</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px;color:#111;font-size:20px;">${options.inviterName} invited you to a health record on Vitals</h2>
              <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
                The record is called <strong>${options.recordName}</strong>.
                Vitals helps people keep track of medications, appointments and
                health history in one place.
              </p>
              <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
                You decide whether to accept. Nothing is shared with you until you do.
              </p>
              <a href="${options.acceptUrl}"
                style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;">
                ${action}
              </a>
              <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.6;">
                This invitation expires in 14 days. If you were not expecting it,
                you can ignore this email and nothing will happen.
              </p>
              <p style="margin:16px 0 0;color:#aaa;font-size:12px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${options.acceptUrl}" style="color:#1a73e8;word-break:break-all;">${options.acceptUrl}</a>
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

  /**
   * A care reminder that could not reach the device.
   *
   * Deliberately the same shell as `medicationFallback` — same header, same
   * button, same footer — with only the wording that would be wrong for a
   * non-medication event changed. Copying the layout beat parameterising the
   * medication template, because the medication copy is the one thing that
   * must not shift as a side effect of adding this.
   *
   * Says what is due and when, and nothing about what it is for. The title
   * already carries as much as the notification did.
   */
  careReminderFallback(title: string, scheduledFor: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Care reminder</title>
</head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#1a73e8;padding:32px 40px;">
              <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Vitals</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px;color:#111;font-size:20px;">Care reminder</h2>
              <p style="margin:0 0 16px;color:#555;font-size:15px;line-height:1.6;">
                This is a reminder about <strong>${title}</strong>,
                scheduled for <strong>${scheduledFor}</strong>.
              </p>
              <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
                Open Vitals to see the details and mark it as done.
              </p>
              <a href="${env.FRONTEND_URL}/care"
                style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;">
                Open Vitals
              </a>
              <p style="margin:24px 0 0;color:#aaa;font-size:12px;">
                You are receiving this because you have care reminders enabled in your Vitals account.
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
</html>
`;
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
            <td style="background:#1a73e8;padding:32px 40px;">
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
                style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;">
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
                <td style="background:#1a73e8;padding:32px 40px;">
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
                    style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;">
                    Reset password
                  </a>

                  <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.6;">
                    This link will expire soon. If you did not request a password reset, you can safely ignore this email.
                  </p>

                  <p style="margin:16px 0 0;color:#aaa;font-size:12px;">
                    If the button doesn't work, copy and paste this link into your browser:<br/>
                    <a href="${resetUrl}" style="color:#1a73e8;word-break:break-all;">${resetUrl}</a>
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
