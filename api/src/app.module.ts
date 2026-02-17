import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { getMongoUri } from './config/mongodb.config';
import { DbModule } from './modules/db/db.module';
import { SessionsModule } from './modules/sessions/sessions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const uri = configService.get<string>('MONGODB_URI')
          ?? configService.get<string>('MONGOD_URI')
          ?? getMongoUri();

        return {
          uri,
          dbName: 'balance',
          // Keep auto-indexing in non-production only; use sync script in production when needed.
          autoIndex: configService.get<string>('NODE_ENV') !== 'production',
        };
      },
    }),
    DbModule,
    SessionsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
