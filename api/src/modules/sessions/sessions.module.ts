import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { FilesController } from './files.controller';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [DbModule, forwardRef(() => AuthModule)],
  controllers: [SessionsController, FilesController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
