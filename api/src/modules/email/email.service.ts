import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const RESEND_API_URL = 'https://api.resend.com/emails';

@Injectable()
export class EmailService {
  constructor(private readonly configService: ConfigService) {}

  async sendMagicLink(email: string, link: string): Promise<void> {
    const provider = (this.configService.get<string>('EMAIL_PROVIDER') ?? 'console').trim().toLowerCase();

    if (provider === 'resend') {
      await this.sendWithResend(email, link);
      return;
    }

    console.log(`[console-email] magic link to ${email}: ${link}`);
  }

  private async sendWithResend(email: string, link: string): Promise<void> {
    const apiKey = this.configService.get<string>('RESEND_API_KEY')?.trim();
    const from = this.configService.get<string>('EMAIL_FROM')?.trim() ?? 'onboarding@resend.dev';

    if (!apiKey) {
      throw new InternalServerErrorException('RESEND_API_KEY is required when EMAIL_PROVIDER=resend.');
    }

    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Your Balance magic link',
        html: `<p>Use this secure link to continue:</p><p><a href="${link}">${link}</a></p>`,
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new InternalServerErrorException(`Failed to send magic link email: ${details}`);
    }
  }
}
