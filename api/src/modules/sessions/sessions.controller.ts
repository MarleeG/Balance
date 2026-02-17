import { Body, Controller, Post } from '@nestjs/common';
import { CreateSessionDto } from './dto/create-session.dto';
import { CreateSessionResponse, SessionsService } from './sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  createSession(@Body() dto: CreateSessionDto): Promise<CreateSessionResponse> {
    return this.sessionsService.createSession(dto);
  }
}
