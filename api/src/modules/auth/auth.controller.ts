import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService, GenericAuthResponse, VerifyResponse } from './auth.service';
import { RequestLinkDto } from './dto/request-link.dto';
import { RequestSessionsDto } from './dto/request-sessions.dto';
import { VerifyDto } from './dto/verify.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('request-link')
  requestLink(@Body() dto: RequestLinkDto, @Req() req: Request): Promise<GenericAuthResponse> {
    return this.authService.requestLink(dto, this.getRequestContext(req));
  }

  @Post('request-sessions')
  requestSessions(@Body() dto: RequestSessionsDto, @Req() req: Request): Promise<GenericAuthResponse> {
    return this.authService.requestSessions(dto, this.getRequestContext(req));
  }

  @Get('verify')
  verify(@Query() dto: VerifyDto): Promise<VerifyResponse> {
    return this.authService.verifyToken(dto.token);
  }

  private getRequestContext(req: Request): { ip?: string; userAgent?: string } {
    return {
      ip: req.ip || req.socket?.remoteAddress,
      userAgent: req.get('user-agent') ?? undefined,
    };
  }
}
