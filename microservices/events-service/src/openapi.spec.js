import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { EventsController } from './events/events.controller';
import { EventsService } from './events/events.service';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';

// Em JavaScript, o Swagger não infere tipos: este teste gera o documento como o main.js faz e
// falha se algum campo ou parâmetro ficar sem tipo declarado (D35).
@Module({
  controllers: [EventsController, MetricsController],
  providers: [
    { provide: EventsService, useValue: {} },
    { provide: MetricsService, useValue: {} },
    { provide: DataSource, useValue: {} },
  ],
})
class DocumentationModule {}

let document;

beforeAll(async () => {
  const app = await NestFactory.create(DocumentationModule, { logger: false });
  document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  await app.close();
});

describe('OpenAPI do events-service', () => {
  it('documenta as rotas públicas, a rota interna de reserva, saúde e métricas', () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      '/events',
      '/events/{id}',
      '/events/{id}/history',
      '/events/{id}/reserve-spot',
      '/health',
      '/metrics',
    ]);
  });

  it('descreve os corpos com os DTOs, mesmo sem metadados de tipo', () => {
    const body = (method, path) =>
      document.paths[path][method].requestBody.content['application/json'].schema.$ref;

    expect(body('post', '/events')).toBe('#/components/schemas/CreateEventDto');
    expect(body('put', '/events/{id}')).toBe('#/components/schemas/UpdateEventDto');
    expect(body('patch', '/events/{id}/reserve-spot')).toBe('#/components/schemas/ReserveSpotDto');
  });

  it('lista só parâmetros com nome, sem parâmetro anônimo vindo da query validada', () => {
    const names = (method, path) =>
      document.paths[path][method].parameters.map((parameter) => parameter.name);

    expect(names('get', '/events').sort()).toEqual(['category', 'limit', 'offset', 'status']);
    expect(names('get', '/events/{id}/history').sort()).toEqual(['id', 'limit', 'offset']);
    for (const operations of Object.values(document.paths)) {
      for (const operation of Object.values(operations)) {
        for (const parameter of operation.parameters ?? []) {
          expect(parameter.name).toBeTruthy();
        }
      }
    }
  });

  it('documenta os campos do evento com os tipos declarados', () => {
    const { properties } = document.components.schemas.EventResponseDto;

    expect(properties.available_spots.type).toBe('number');
    expect(properties.status.enum).toEqual(['PUBLISHED', 'SOLD_OUT', 'CANCELLED', 'FINISHED']);
    expect(properties.start_at).toMatchObject({ type: 'string', format: 'date-time' });
  });
});
