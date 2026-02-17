import { Body, Controller, Delete, Get, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { AccessTokenPayload } from '../auth/auth.service';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateSessionDto } from './dto/create-session.dto';
import { CreateSessionResponse, DeleteSessionResponse, SessionSummary, SessionsService } from './sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  createSession(@Body() dto: CreateSessionDto): Promise<CreateSessionResponse> {
    return this.sessionsService.createSession(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async listSessions(@Req() req: AuthenticatedRequest): Promise<SessionSummary[]> {
    const user = this.getAuthenticatedUser(req);

    if (user.type === 'continue_session' && user.sessionId) {
      const session = await this.sessionsService.getActiveSessionById(user.sessionId, user);
      return [session];
    }

    return this.sessionsService.listActiveSessionsForEmail(user.email);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':sessionId')
  getSessionById(@Param('sessionId') sessionId: string, @Req() req: AuthenticatedRequest): Promise<SessionSummary> {
    return this.sessionsService.getActiveSessionById(sessionId, this.getAuthenticatedUser(req));
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':sessionId')
  deleteSession(@Param('sessionId') sessionId: string, @Req() req: AuthenticatedRequest): Promise<DeleteSessionResponse> {
    return this.sessionsService.deleteActiveSessionById(sessionId, this.getAuthenticatedUser(req));
  }

  private getAuthenticatedUser(req: AuthenticatedRequest): AccessTokenPayload {
    if (!req.user) {
      throw new UnauthorizedException('Missing authenticated user context.');
    }

    return req.user;
  }
}
