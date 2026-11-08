import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { correlationMiddleware, logEvent } from './metrics/telemetry';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.use(correlationMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableCors();
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('events-tickets-ms - Tickets Microservice API')
    .setDescription('Inscrições e emissão de ingressos da plataforma events-tickets-ms.')
    .setVersion('1.0.0')
    .build();
  // Caminhos públicos: o gateway encaminha /docs/tickets sem reescrever a URL.
  SwaggerModule.setup('docs/tickets', app, SwaggerModule.createDocument(app, swaggerConfig), {
    jsonDocumentUrl: 'docs/tickets/openapi.json',
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  logEvent('STARTUP', { status: 'ready', port });
}

void bootstrap();
