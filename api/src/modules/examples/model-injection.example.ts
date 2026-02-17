import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmailToken, EmailTokenDocument } from '../../db/schemas/email-token.schema';
import { FileDocument, FileRecord } from '../../db/schemas/file.schema';
import { Session, SessionDocument } from '../../db/schemas/session.schema';

@Injectable()
export class ModelInjectionExampleService {
  constructor(
    @InjectModel(Session.name)
    private readonly sessionsModel: Model<SessionDocument>,
    @InjectModel(FileRecord.name)
    private readonly filesModel: Model<FileDocument>,
    @InjectModel(EmailToken.name)
    private readonly emailTokensModel: Model<EmailTokenDocument>,
  ) {}

  // Example no-op to show all three models are injectable.
  getModelNames() {
    return [
      this.sessionsModel.modelName,
      this.filesModel.modelName,
      this.emailTokensModel.modelName,
    ];
  }
}
