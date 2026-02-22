import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';
import { StatementParserService } from './statement-parser.service';

@Module({
  imports: [DbModule, SessionsModule, AuthModule, StorageModule],
  controllers: [InsightsController],
  providers: [InsightsService, StatementParserService],
  exports: [InsightsService, StatementParserService],
})
export class InsightsModule {}
