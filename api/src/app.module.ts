import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { getMongoUri } from './config/mongodb.config';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => ({ uri: getMongoUri() }),
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
