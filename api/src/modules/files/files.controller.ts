import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { StatementType } from '../../db/schemas/file.schema';
import type { AccessTokenPayload } from '../auth/auth.service';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateFileDto } from './dto/update-file.dto';
import {
  DeleteFileResponse,
  FilesService,
  MultipartFile,
  SessionFileSummary,
  UpdateFileResponse,
  UploadFilesResponse,
} from './files.service';
import { ParseUploadMetaPipe } from './pipes/parse-upload-meta.pipe';

@Controller()
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @UseGuards(JwtAuthGuard)
  @Post('sessions/:sessionId/files')
  @UseInterceptors(FilesInterceptor('files'))
  uploadFiles(
    @Param('sessionId') sessionId: string,
    @UploadedFiles() files: MultipartFile[],
    @Body('meta', ParseUploadMetaPipe) metaByName: Map<string, StatementType>,
    @Req() req: AuthenticatedRequest,
  ): Promise<UploadFilesResponse> {
    return this.filesService.uploadFilesToSession(sessionId, this.getAuthenticatedUser(req), files, metaByName);
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions/:sessionId/files')
  listSessionFiles(@Param('sessionId') sessionId: string, @Req() req: AuthenticatedRequest): Promise<SessionFileSummary[]> {
    return this.filesService.listSessionFiles(sessionId, this.getAuthenticatedUser(req));
  }

  @UseGuards(JwtAuthGuard)
  @Patch('files/:fileId')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  updateFile(
    @Param('fileId') fileId: string,
    @Body() dto: UpdateFileDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<UpdateFileResponse> {
    return this.filesService.updateFileStatementType(fileId, dto.statementType, this.getAuthenticatedUser(req));
  }

  @UseGuards(JwtAuthGuard)
  @Delete('files/:fileId')
  deleteFile(@Param('fileId') fileId: string, @Req() req: AuthenticatedRequest): Promise<DeleteFileResponse> {
    return this.filesService.deleteFile(fileId, this.getAuthenticatedUser(req));
  }

  private getAuthenticatedUser(req: AuthenticatedRequest): AccessTokenPayload {
    if (!req.user) {
      throw new UnauthorizedException('Missing authenticated user context.');
    }

    return req.user;
  }
}
