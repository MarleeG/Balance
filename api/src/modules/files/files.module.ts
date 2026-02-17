import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { StorageModule } from '../storage/storage.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { ParseUploadMetaPipe } from './pipes/parse-upload-meta.pipe';

@Module({
  imports: [DbModule, StorageModule, AuthModule],
  controllers: [FilesController],
  providers: [FilesService, ParseUploadMetaPipe],
  exports: [FilesService],
})
export class FilesModule {}
