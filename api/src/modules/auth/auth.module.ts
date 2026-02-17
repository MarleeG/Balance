import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { EmailModule } from '../email/email.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AuthController } from './auth.controller';
import { AuthRateLimiterService } from './rate-limiter.service';
import { AuthService } from './auth.service';

@Module({
  imports: [DbModule, SessionsModule, EmailModule],
  controllers: [AuthController],
  providers: [AuthService, AuthRateLimiterService],
})
export class AuthModule {}
