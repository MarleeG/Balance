import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EmailToken, EmailTokenSchema } from '../../db/schemas/email-token.schema';
import { FileRecord, FileSchema } from '../../db/schemas/file.schema';
import { Label, LabelSchema } from '../../db/schemas/label.schema';
import { LabelRule, LabelRuleSchema } from '../../db/schemas/label-rule.schema';
import { ParseJob, ParseJobSchema } from '../../db/schemas/parse-job.schema';
import { ParsedStatement, ParsedStatementSchema } from '../../db/schemas/parsed-statement.schema';
import { Session, SessionSchema } from '../../db/schemas/session.schema';
import { TransactionLabel, TransactionLabelSchema } from '../../db/schemas/transaction-label.schema';
import { TransactionRecord, TransactionSchema } from '../../db/schemas/transaction.schema';

@Module({
  imports: [
    MongooseModule.forFeatureAsync([
      {
        name: Session.name,
        useFactory: () => SessionSchema,
      },
      {
        name: FileRecord.name,
        useFactory: () => FileSchema,
      },
      {
        name: EmailToken.name,
        useFactory: () => EmailTokenSchema,
      },
      {
        name: ParsedStatement.name,
        useFactory: () => ParsedStatementSchema,
      },
      {
        name: TransactionRecord.name,
        useFactory: () => TransactionSchema,
      },
      {
        name: Label.name,
        useFactory: () => LabelSchema,
      },
      {
        name: TransactionLabel.name,
        useFactory: () => TransactionLabelSchema,
      },
      {
        name: LabelRule.name,
        useFactory: () => LabelRuleSchema,
      },
      {
        name: ParseJob.name,
        useFactory: () => ParseJobSchema,
      },
    ]),
  ],
  exports: [MongooseModule],
})
export class DbModule {}
