import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [DbModule],
  controllers: [SessionsController],
  providers: [SessionsService],
})
export class SessionsModule {}
