import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AccessTokenPayload } from './auth.service';

const INVALID_ACCESS_TOKEN_MESSAGE = 'Invalid or expired access token.';

@Injectable()
export class JwtStrategy {
  constructor(private readonly jwtService: JwtService) {}

  async validateAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);

      if (!payload?.email || !this.isValidType(payload.type)) {
        throw new UnauthorizedException(INVALID_ACCESS_TOKEN_MESSAGE);
      }

      if (payload.type === 'continue_session' && !payload.sessionId) {
        throw new UnauthorizedException(INVALID_ACCESS_TOKEN_MESSAGE);
      }

      return payload;
    } catch {
      throw new UnauthorizedException(INVALID_ACCESS_TOKEN_MESSAGE);
    }
  }

  private isValidType(value: string): value is AccessTokenPayload['type'] {
    return value === 'continue_session' || value === 'find_sessions';
  }
}
