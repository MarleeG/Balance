import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { AccessTokenPayload } from '../auth/auth.service';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AttachTransactionLabelDto } from './dto/attach-transaction-label.dto';
import { CreateLabelDto } from './dto/create-label.dto';
import { CreateLabelRuleDto } from './dto/create-label-rule.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';
import { QueueParseDto } from './dto/queue-parse.dto';
import {
  AttachLabelResponse,
  InsightsService,
  LabelResponse,
  LabelRuleResponse,
  QueueParseResponse,
  RemoveLabelResponse,
} from './insights.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class InsightsController {
  constructor(private readonly insightsService: InsightsService) {}

  @Post('sessions/:sessionId/parse')
  queueParse(
    @Param('sessionId') sessionId: string,
    @Body() dto: QueueParseDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<QueueParseResponse> {
    return this.insightsService.queueParseForSession(
      sessionId,
      dto.fileIds,
      this.getAuthenticatedUser(req),
    );
  }

  @Get('sessions/:sessionId/parsed')
  listParsed(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<Array<Record<string, unknown>>> {
    return this.insightsService.listParsedStatements(sessionId, this.getAuthenticatedUser(req));
  }

  @Get('sessions/:sessionId/transactions')
  listTransactions(
    @Param('sessionId') sessionId: string,
    @Query() query: ListTransactionsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Array<Record<string, unknown>>> {
    return this.insightsService.listTransactions(
      sessionId,
      query.fileId,
      this.getAuthenticatedUser(req),
    );
  }

  @Post('labels')
  createLabel(
    @Body() dto: CreateLabelDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabelResponse> {
    return this.insightsService.createLabel(dto, this.getAuthenticatedUser(req));
  }

  @Get('labels')
  listLabels(@Req() req: AuthenticatedRequest): Promise<LabelResponse[]> {
    return this.insightsService.listLabels(this.getAuthenticatedUser(req));
  }

  @Post('transactions/:transactionId/labels')
  attachLabelToTransaction(
    @Param('transactionId') transactionId: string,
    @Body() dto: AttachTransactionLabelDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AttachLabelResponse> {
    return this.insightsService.attachLabelToTransaction(
      transactionId,
      dto.labelId,
      this.getAuthenticatedUser(req),
    );
  }

  @Delete('transactions/:transactionId/labels/:labelId')
  removeLabelFromTransaction(
    @Param('transactionId') transactionId: string,
    @Param('labelId') labelId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<RemoveLabelResponse> {
    return this.insightsService.removeLabelFromTransaction(
      transactionId,
      labelId,
      this.getAuthenticatedUser(req),
    );
  }

  @Post('label-rules')
  createLabelRule(
    @Body() dto: CreateLabelRuleDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabelRuleResponse> {
    return this.insightsService.createLabelRule(dto, this.getAuthenticatedUser(req));
  }

  @Get('label-rules')
  listLabelRules(@Req() req: AuthenticatedRequest): Promise<LabelRuleResponse[]> {
    return this.insightsService.listLabelRules(this.getAuthenticatedUser(req));
  }

  private getAuthenticatedUser(req: AuthenticatedRequest): AccessTokenPayload {
    if (!req.user) {
      throw new UnauthorizedException('Missing authenticated user context.');
    }

    return req.user;
  }
}
