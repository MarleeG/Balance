import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getCorsOrigins } from './config/cors.config';
import { initializeStartupConnections, loadEnvFile } from './startup/bootstrap.helpers';

async function bootstrap() {
  loadEnvFile();
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = getCorsOrigins();

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(null, allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));
  await initializeStartupConnections(app);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
