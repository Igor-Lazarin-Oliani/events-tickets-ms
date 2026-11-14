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
    .setDescription(
      'Inscrições, emissão de ingressos e check-in da plataforma events-tickets-ms. A vaga é reservada ' +
        'no events-service por HTTP e devolvida pelo RabbitMQ; cada mudança gera um registro de atividade ' +
        'enviado ao logs-service.',
    )
    .setVersion('3.0.0')
    .build();
  // Caminhos públicos: o gateway encaminha /docs/tickets sem reescrever a URL.
  SwaggerModule.setup('docs/tickets', app, SwaggerModule.createDocument(app, swaggerConfig), {
    jsonDocumentUrl: 'docs/tickets/openapi.json',
  });

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port, '0.0.0.0');
  logEvent('STARTUP', { status: 'ready', port });
}

void bootstrap();
