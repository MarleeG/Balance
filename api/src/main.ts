import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { initializeStartupConnections, loadEnvFile } from './startup/bootstrap.helpers';

async function bootstrap() {
  loadEnvFile();
  const app = await NestFactory.create(AppModule);
  await initializeStartupConnections(app);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
