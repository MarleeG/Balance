import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DbModule } from '../db/db.module';
import { EmailModule } from '../email/email.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { AuthRateLimiterService } from './rate-limiter.service';
import { AuthService } from './auth.service';

function getSanitizedEnvValue(configService: ConfigService, name: string): string | null {
  const value = configService.get<string>(name);
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted || null;
  }

  return trimmed;
}

function getNormalizedJwtExpiresIn(configService: ConfigService): string {
  const raw = getSanitizedEnvValue(configService, 'JWT_EXPIRES_IN');
  if (!raw) {
    return '1h';
  }

  const numericSeconds = Number.parseInt(raw, 10);
  if (Number.isInteger(numericSeconds) && numericSeconds > 0 && String(numericSeconds) === raw) {
    return String(numericSeconds);
  }

  const normalizedTimespan = raw.toLowerCase().replace(/\s+/g, '');
  if (/^\d+[smhd]$/.test(normalizedTimespan)) {
    return normalizedTimespan;
  }

  return '1h';
}

@Module({
  imports: [
    DbModule,
    forwardRef(() => SessionsModule),
    EmailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const nodeEnv = configService.get<string>('NODE_ENV')?.trim().toLowerCase();
        const secretName = nodeEnv === 'prod' || nodeEnv === 'production'
          ? 'JWT_SECRET_PRD'
          : 'JWT_SECRET_LOCAL';
        const secret = getSanitizedEnvValue(configService, secretName);
        if (!secret) {
          throw new Error(`${secretName} must be configured.`);
        }

        return {
          secret,
          signOptions: {
            expiresIn: getNormalizedJwtExpiresIn(configService),
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRateLimiterService, JwtStrategy, JwtAuthGuard],
  exports: [JwtModule, JwtStrategy, JwtAuthGuard],
})
export class AuthModule {}
