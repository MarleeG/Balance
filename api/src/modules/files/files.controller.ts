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
  Res,
  StreamableFile,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { StatementType } from '../../db/schemas/file.schema';
import type { AccessTokenPayload } from '../auth/auth.service';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MoveFilesToCategoryDto } from './dto/move-files.dto';
import { UpdateFileDto } from './dto/update-file.dto';
import {
  DetectFilesResponse,
  DeleteFileResponse,
  FilesService,
  MoveFilesToCategoryResponse,
  MultipartFile,
  RawFileResponse,
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
  @Post('sessions/:sessionId/files/detect')
  @UseInterceptors(FilesInterceptor('files'))
  detectFiles(
    @Param('sessionId') sessionId: string,
    @UploadedFiles() files: MultipartFile[],
    @Req() req: AuthenticatedRequest,
  ): Promise<DetectFilesResponse> {
    return this.filesService.detectFilesForSession(sessionId, this.getAuthenticatedUser(req), files);
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
  @Patch('sessions/:sessionId/files/category')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  moveFilesToCategory(
    @Param('sessionId') sessionId: string,
    @Body() dto: MoveFilesToCategoryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MoveFilesToCategoryResponse> {
    return this.filesService.moveFilesToCategory(
      sessionId,
      dto.fileIds,
      dto.category,
      this.getAuthenticatedUser(req),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('files/:fileId')
  deleteFile(@Param('fileId') fileId: string, @Req() req: AuthenticatedRequest): Promise<DeleteFileResponse> {
    return this.filesService.deleteFile(fileId, this.getAuthenticatedUser(req));
  }

  @UseGuards(JwtAuthGuard)
  @Get('files/:fileId/raw')
  async getRawFile(
    @Param('fileId') fileId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rawFile = await this.filesService.getRawFile(fileId, this.getAuthenticatedUser(req));
    this.applyRawFileHeaders(res, rawFile);
    return new StreamableFile(rawFile.body);
  }

  private applyRawFileHeaders(res: Response, rawFile: RawFileResponse): void {
    const sanitizedFileName = rawFile.fileName.replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', rawFile.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${sanitizedFileName}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
  }

  private getAuthenticatedUser(req: AuthenticatedRequest): AccessTokenPayload {
    if (!req.user) {
      throw new UnauthorizedException('Missing authenticated user context.');
    }

    return req.user;
  }
}
