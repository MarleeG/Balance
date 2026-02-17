import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../app.module';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const connection = app.get<Connection>(getConnectionToken());
    await connection.syncIndexes();
    console.log('Mongo indexes synced');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Failed to sync Mongo indexes', error);
  process.exit(1);
});
