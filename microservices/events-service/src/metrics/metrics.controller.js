import {
  Bind,
  Controller,
  Dependencies,
  Get,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { MetricsService } from './metrics.service';
import { SERVICE_NAME } from './telemetry';

@ApiTags('Observability')
@Controller()
@Dependencies(MetricsService, DataSource)
export class MetricsController {
  constructor(metrics, dataSource) {
    this.metrics = metrics;
    this.dataSource = dataSource;
  }

  @Get('health')
  @ApiOperation({
    summary: 'Verifica a saúde do serviço',
    description:
      'Confirma que a API está no ar e que o banco responde. Rota interna; pelo gateway, use /health/events.',
  })
  @ApiResponse({
    status: 200,
    description: 'Serviço e banco disponíveis.',
    schema: { example: { status: 'ok', service: 'events-service', database: 'up' } },
  })
  @ApiResponse({
    status: 503,
    description: 'Banco de dados indisponível.',
    schema: { example: { status: 'error', service: 'events-service', database: 'down' } },
  })
  async health() {
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
      'Inclui métricas padrão do Node.js, HTTP, reservas e devoluções de vagas, outbox e mensagens consumidas. ' +
      'Rota interna; pelo gateway, use /metrics/events.',
  })
  @ApiProduces('text/plain')
  @ApiResponse({ status: 200, description: 'Métricas em texto no formato Prometheus.' })
  @Bind(Res({ passthrough: true }))
  async getMetrics(response) {
    response.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
