import { Controller, Get, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { MetricsService } from './metrics.service';
import { SERVICE_NAME } from './telemetry';

@ApiTags('Observability')
@Controller()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get('health')
  @ApiOperation({
    summary: 'Verifica a saúde do serviço',
    description:
      'Confirma que a API está no ar e que o banco responde. Rota interna; pelo gateway, use /health/events-tickets.',
  })
  @ApiResponse({
    status: 200,
    description: 'Serviço e banco disponíveis.',
    schema: { example: { status: 'ok', service: 'events-tickets-service', database: 'up' } },
  })
  @ApiResponse({
    status: 503,
    description: 'Banco de dados indisponível.',
    schema: { example: { status: 'error', service: 'events-tickets-service', database: 'down' } },
  })
  async health(): Promise<Record<string, string>> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        service: SERVICE_NAME,
        database: 'down',
      });
    }
    return { status: 'ok', service: SERVICE_NAME, database: 'up' };
  }

  @Get('metrics')
  @ApiOperation({
    summary: 'Expõe as métricas no formato Prometheus',
    description:
      'Inclui métricas padrão do Node.js, HTTP, ingressos, vagas e outbox. Rota interna; pelo gateway, use /metrics/events-tickets.',
  })
  @ApiProduces('text/plain')
  @ApiResponse({ status: 200, description: 'Métricas em texto no formato Prometheus.' })
  async getMetrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
