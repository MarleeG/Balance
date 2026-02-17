import { Controller, Delete, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

interface DeleteFileStubResponse {
  deleted: boolean;
  fileId: string;
  message: string;
}

@Controller('files')
export class FilesController {
  @UseGuards(JwtAuthGuard)
  @Delete(':fileId')
  deleteFile(@Param('fileId') fileId: string): DeleteFileStubResponse {
    return {
      deleted: true,
      fileId,
      message: 'File deletion endpoint is protected and ready for implementation.',
    };
  }
}
