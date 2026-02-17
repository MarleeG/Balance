import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EmailToken, EmailTokenSchema } from '../../db/schemas/email-token.schema';
import { FileRecord, FileSchema } from '../../db/schemas/file.schema';
import { Session, SessionSchema } from '../../db/schemas/session.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: FileRecord.name, schema: FileSchema },
      { name: EmailToken.name, schema: EmailTokenSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class DbModule {}
