import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getCorsOrigins } from './config/cors.config';
import {
  buildClientPublicUrl,
  getSanitizedApiPublicUrl,
  getSanitizedClientPublicUrl,
} from './config/public-url.config';
import { initializeStartupConnections, loadEnvFile } from './startup/bootstrap.helpers';

function isDevLoggingEnv(): boolean {
  const raw = process.env.NODE_ENV?.trim().toLowerCase();
  return raw === 'local' || raw === 'dev' || raw === 'development';
}

function logPublicUrlDiagnostics(): void {
  if (!isDevLoggingEnv()) {
    return;
  }

  const sanitizedClientPublicUrl = getSanitizedClientPublicUrl();
  const sanitizedApiPublicUrl = getSanitizedApiPublicUrl();
  const sampleVerifyUrl = buildClientPublicUrl('/auth/verify', { token: 'sample-token' });
  console.log(
    JSON.stringify({
      event: 'startup.public-url',
      clientPublicUrl: sanitizedClientPublicUrl,
      apiPublicUrl: sanitizedApiPublicUrl,
      sampleVerifyUrl,
    }),
  );
}

async function bootstrap() {
  loadEnvFile();
  logPublicUrlDiagnostics();
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
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
