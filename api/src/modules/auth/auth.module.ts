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
        const secret = configService.get<string>(secretName)?.trim();
        if (!secret) {
          throw new Error(`${secretName} must be configured.`);
        }

        return {
          secret,
          signOptions: {
            expiresIn: configService.get<string>('JWT_EXPIRES_IN')?.trim() || '1h',
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
