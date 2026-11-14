import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { correlationMiddleware, logEvent } from './metrics/telemetry';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // A validação fica em cada parâmetro (ValidBody e ValidQuery), e não em um pipe global (D35).
  app.use(correlationMiddleware);
  app.enableCors();
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('events-tickets-ms - Events Microservice API')
    .setDescription(
      'Eventos e controle de vagas da plataforma events-tickets-ms, em JavaScript. O tickets-service reserva ' +
        'vagas por HTTP e as devolve pelo RabbitMQ; cada mudança gera um registro de atividade enviado ao ' +
        'logs-service.',
    )
    .setVersion('3.0.0')
    .build();
  // Caminhos públicos: o gateway encaminha /docs/events sem reescrever a URL.
  SwaggerModule.setup('docs/events', app, SwaggerModule.createDocument(app, swaggerConfig), {
    jsonDocumentUrl: 'docs/events/openapi.json',
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  logEvent('STARTUP', { status: 'ready', port });
}

void bootstrap();
