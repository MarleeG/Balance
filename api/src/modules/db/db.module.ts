import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EmailToken, EmailTokenSchema } from '../../db/schemas/email-token.schema';
import { FileRecord, FileSchema } from '../../db/schemas/file.schema';
import { Session, SessionSchema } from '../../db/schemas/session.schema';

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
    ]),
  ],
  exports: [MongooseModule],
})
export class DbModule {}
