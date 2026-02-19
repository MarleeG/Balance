import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildClientPublicUrl } from '../../config/public-url.config';

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_EMAIL_PROVIDER = 'console';
const DEFAULT_EMAIL_FROM = 'onboarding@resend.dev';
const DEFAULT_MAGIC_LINK_TTL_MINUTES = 15;
const DEFAULT_RESEND_TIMEOUT_MS = 8000;
const DEFAULT_RESEND_RETRY_COUNT = 2;
const DEFAULT_RESEND_RETRY_BASE_DELAY_MS = 400;
const RESEND_SESSIONS_SUBJECT = 'Your Balance sessions';
const RETRYABLE_RESEND_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function normalizeEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const isSingleQuoted = trimmed.startsWith('\'') && trimmed.endsWith('\'');

  if (isDoubleQuoted || isSingleQuoted) {
    return trimmed.slice(1, -1).trim() || undefined;
  }

  return trimmed;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly configService: ConfigService) {}

  async sendMagicLink(email: string, rawToken: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const link = buildClientPublicUrl('/auth/verify', { token: rawToken });
    const ttlMinutes = this.getMagicLinkTtlMinutes();
    const provider = (normalizeEnv(this.configService.get<string>('EMAIL_PROVIDER')) ?? DEFAULT_EMAIL_PROVIDER).toLowerCase();

    if (provider === 'resend') {
      await this.sendWithResend(normalizedEmail, link, ttlMinutes);
      return;
    }

    console.log(`[console-email] magic link to ${normalizedEmail}: ${link}`);
  }

  private async sendWithResend(email: string, link: string, ttlMinutes: number): Promise<void> {
    const apiKey = normalizeEnv(this.configService.get<string>('RESEND_API_KEY'));
    const from = normalizeEnv(this.configService.get<string>('EMAIL_FROM')) ?? DEFAULT_EMAIL_FROM;

    if (!apiKey) {
      throw new InternalServerErrorException('RESEND_API_KEY is required when EMAIL_PROVIDER=resend.');
    }

    const timeoutMs = this.getResendTimeoutMs();
    const maxAttempts = this.getResendRetryCount() + 1;
    const payload = JSON.stringify({
      from,
      to: [email],
      subject: RESEND_SESSIONS_SUBJECT,
      html: this.buildMagicLinkHtml(link, ttlMinutes),
      text: this.buildMagicLinkText(link, ttlMinutes),
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptLabel = `${attempt}/${maxAttempts}`;
      try {
        const response = await fetch(RESEND_API_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: payload,
        });

        const responseBody = await this.readResponseBody(response);
        if (!response.ok) {
          const responseDetails = `Resend send failed (${response.status} ${response.statusText}) for ${email}: ${responseBody}`;
          if (RETRYABLE_RESEND_STATUS_CODES.has(response.status) && attempt < maxAttempts) {
            const delayMs = this.getResendRetryDelayMs(attempt);
            this.logger.warn(`${responseDetails}. Retrying in ${delayMs}ms (attempt ${attemptLabel}).`);
            await this.delay(delayMs);
            continue;
          }

          this.logger.error(responseDetails);
          throw new InternalServerErrorException(`Failed to send magic link email: ${responseBody}`);
        }

        if (this.isDevLoggingEnabled()) {
          const resendId = this.getResendResponseId(responseBody);
          this.logger.debug(
            JSON.stringify({
              event: 'email.resend.sent',
              provider: 'resend',
              to: email,
              from,
              resendId,
              attempt,
            }),
          );
        }

        return;
      } catch (error) {
        if (this.isRetryableResendError(error) && attempt < maxAttempts) {
          const delayMs = this.getResendRetryDelayMs(attempt);
          this.logger.warn(
            `Resend send attempt ${attemptLabel} for ${email} failed with retryable error: ${this.getErrorMessage(error)}. Retrying in ${delayMs}ms.`,
          );
          await this.delay(delayMs);
          continue;
        }

        this.logger.error(
          `Resend send threw for ${email}: ${this.getErrorMessage(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        throw error;
      }
    }
  }

  private async readResponseBody(response: Response): Promise<string> {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('application/json')) {
      try {
        return JSON.stringify(await response.json());
      } catch {
        return '';
      }
    }

    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  private getResendResponseId(responseBody: string): string | null {
    if (!responseBody) {
      return null;
    }

    try {
      const parsed = JSON.parse(responseBody) as { id?: string };
      return typeof parsed.id === 'string' ? parsed.id : null;
    } catch {
      return null;
    }
  }

  private isDevLoggingEnabled(): boolean {
    const nodeEnv = normalizeEnv(this.configService.get<string>('NODE_ENV'))?.toLowerCase();
    return nodeEnv === 'development' || nodeEnv === 'dev' || nodeEnv === 'local';
  }

  private getMagicLinkTtlMinutes(): number {
    const raw = normalizeEnv(this.configService.get<string>('MAGIC_LINK_TTL_MINUTES'));
    const parsed = Number.parseInt(raw ?? '', 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }

    return DEFAULT_MAGIC_LINK_TTL_MINUTES;
  }

  private getResendTimeoutMs(): number {
    const raw = normalizeEnv(this.configService.get<string>('RESEND_TIMEOUT_MS'));
    const parsed = Number.parseInt(raw ?? '', 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }

    return DEFAULT_RESEND_TIMEOUT_MS;
  }

  private getResendRetryCount(): number {
    const raw = normalizeEnv(this.configService.get<string>('RESEND_RETRY_COUNT'));
    const parsed = Number.parseInt(raw ?? '', 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 5) {
      return parsed;
    }

    return DEFAULT_RESEND_RETRY_COUNT;
  }

  private getResendRetryBaseDelayMs(): number {
    const raw = normalizeEnv(this.configService.get<string>('RESEND_RETRY_BASE_DELAY_MS'));
    const parsed = Number.parseInt(raw ?? '', 10);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 5000) {
      return parsed;
    }

    return DEFAULT_RESEND_RETRY_BASE_DELAY_MS;
  }

  private getResendRetryDelayMs(attempt: number): number {
    const base = this.getResendRetryBaseDelayMs();
    const exponential = base * (2 ** Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * base);
    return Math.min(exponential + jitter, 10_000);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private isRetryableResendError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    if (
      name.includes('timeout')
      || message.includes('aborted due to timeout')
      || message.includes('fetch failed')
    ) {
      return true;
    }

    const cause = (error as Error & { cause?: unknown }).cause;
    if (!cause || typeof cause !== 'object') {
      return false;
    }

    const causeRecord = cause as { code?: unknown; message?: unknown };
    const causeCode = typeof causeRecord.code === 'string' ? causeRecord.code.toLowerCase() : '';
    const causeMessage = typeof causeRecord.message === 'string' ? causeRecord.message.toLowerCase() : '';
    if (
      causeCode.includes('timeout')
      || causeCode.includes('econnreset')
      || causeCode.includes('econnrefused')
      || causeCode.includes('enotfound')
      || causeCode.includes('eai_again')
      || causeCode.includes('und_err')
      || causeMessage.includes('timeout')
      || causeMessage.includes('socket')
      || causeMessage.includes('network')
    ) {
      return true;
    }

    return false;
  }

  private getErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }

    const cause = (error as Error & { cause?: unknown }).cause;
    if (!cause || typeof cause !== 'object') {
      return error.message;
    }

    const causeRecord = cause as { code?: string; message?: string };
    const causeCode = typeof causeRecord.code === 'string' ? causeRecord.code : null;
    const causeMessage = typeof causeRecord.message === 'string' ? causeRecord.message : null;
    if (!causeCode && !causeMessage) {
      return error.message;
    }

    return `${error.message} (cause: ${causeCode ?? 'unknown'}${causeMessage ? ` ${causeMessage}` : ''})`;
  }

  private buildMagicLinkHtml(link: string, ttlMinutes: number): string {
    return `
<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;">
            <tr>
              <td>
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin-bottom:20px;">
                  <tr>
                    <td style="vertical-align:middle;">
                      <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:separate;">
                        <tr>
                          <td
                            width="13"
                            height="13"
                            style="width:13px;height:13px;min-width:13px;line-height:13px;font-size:0;border-radius:999px;background-color:#22d3ee;background-image:linear-gradient(130deg,#22d3ee,#14b8a6);box-shadow:0 0 0 4px rgba(34,211,238,0.15);"
                          >
                            &nbsp;
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td style="padding-left:10px;vertical-align:middle;font-size:22px;font-weight:700;color:#0f172a;">Balance</td>
                  </tr>
                </table>
                <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.3;">Your secure Balance link</h1>
                <p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:#334155;">
                  Use this secure link to view and continue your sessions.
                </p>
                <p style="margin:0 0 20px 0;">
                  <a href="${link}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px;">
                    Continue session
                  </a>
                </p>
                <p style="margin:0 0 8px 0;font-size:13px;line-height:1.5;color:#475569;">
                  If the button does not work, copy and paste this link into your browser:
                </p>
                <p style="margin:0 0 16px 0;padding:12px;border-radius:10px;border:1px dashed #cbd5e1;background:#f8fafc;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,'Courier New',monospace;font-size:12px;line-height:1.5;color:#0f172a;word-break:break-all;overflow-wrap:anywhere;">
                  ${link}
                </p>
                <p style="margin:0 0 14px 0;font-size:13px;line-height:1.5;color:#475569;">
                  This link expires in ${ttlMinutes} minutes.
                </p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:#64748b;">
                  If you didn't request this, you can ignore this email.
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
  }

  private buildMagicLinkText(link: string, ttlMinutes: number): string {
    return [
      'Balance',
      '',
      'Use this secure link to view and continue your sessions:',
      link,
      '',
      `This link expires in ${ttlMinutes} minutes.`,
      "If you didn't request this, you can ignore this email.",
    ].join('\n');
  }
}
