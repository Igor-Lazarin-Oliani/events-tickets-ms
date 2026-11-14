import { HttpService } from '@nestjs/axios';
import { Dependencies, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { TOTAL_COUNT_HEADER } from '../common/pagination';
import { reasonOf } from '../common/postgres-errors';
import { CORRELATION_HEADER, getCorrelationId, logEvent } from '../metrics/telemetry';

// O maior limite aceito pelo GET /logs: o histórico de quase todo evento cabe em uma página.
export const DEFAULT_HISTORY_LIMIT = 500;

/** Total informado pelo logs-service no cabeçalho, ou null se ele não vier. */
function totalFrom(headers) {
  // O axios entrega os nomes dos cabeçalhos em minúsculas.
  const total = Number(headers?.[TOTAL_COUNT_HEADER.toLowerCase()]);
  return Number.isInteger(total) && total >= 0 ? total : null;
}

/** Chamada HTTP síncrona do events-service ao logs-service: o histórico de um evento (D21). */
@Injectable()
@Dependencies(HttpService)
export class LogsClientService {
  constructor(http) {
    this.http = http;
  }

  async getHistory(entityType, entityId, page = { limit: DEFAULT_HISTORY_LIMIT, offset: 0 }) {
    const target = `logs-service/logs?entity_type=${entityType}&entity_id=${entityId}`;
    const startedAt = Date.now();
    logEvent('HTTP SYNC REQUEST', { method: 'GET', target, ...page });

    try {
      const response = await firstValueFrom(
        this.http.get('/logs', {
          params: {
            entity_type: entityType,
            entity_id: entityId,
            order: 'asc',
            limit: page.limit,
            offset: page.offset,
          },
          headers: { [CORRELATION_HEADER]: getCorrelationId() },
        }),
      );
      const total = totalFrom(response.headers);
      logEvent('HTTP SYNC RESPONSE', {
        method: 'GET',
        target,
        status: response.status,
        entries: response.data.length,
        total,
        duration_ms: Date.now() - startedAt,
      });
      return {
        entity_type: entityType,
        entity_id: entityId,
        total,
        limit: page.limit,
        offset: page.offset,
        entries: response.data,
      };
    } catch (error) {
      logEvent(
        'HTTP SYNC FAILURE',
        {
          method: 'GET',
          target,
          status: isAxiosError(error) ? (error.response?.status ?? null) : null,
          reason: reasonOf(error),
          duration_ms: Date.now() - startedAt,
        },
        'WARNING',
      );
      // Sem o histórico, o resto da API continua funcionando: só esta rota responde 503.
      throw new ServiceUnavailableException('Logs service unavailable');
    }
  }
}
