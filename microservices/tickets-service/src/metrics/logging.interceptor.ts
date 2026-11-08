import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { MetricsService } from './metrics.service';
import { getCorrelationId, logEvent } from './telemetry';

// Chamados a todo instante pelo healthcheck e por coletores; poluiriam a demonstração ao vivo.
const UNTRACKED_PATHS = new Set(['/health', '/metrics']);

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    if (!UNTRACKED_PATHS.has(request.path)) {
      const correlationId = getCorrelationId();
      const startedAt = process.hrtime.bigint();
      // O padrão da rota mantém a cardinalidade das métricas limitada.
      const route: string = request.route?.path ?? request.path;

      // "finish" enxerga o status final, inclusive o definido pelos filtros de exceção.
      response.once('finish', () => {
        const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        this.metrics.recordHttpRequest(
          request.method,
          route,
          response.statusCode,
          durationSeconds,
        );
        logEvent('TELEMETRY', {
          correlation_id: correlationId,
          method: request.method,
          route,
          status: response.statusCode,
          duration_ms: Math.round(durationSeconds * 100000) / 100,
        });
      });
    }

    return next.handle();
  }
}
