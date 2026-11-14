import { HttpService } from '@nestjs/axios';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { PageRequest, TOTAL_COUNT_HEADER } from '../common/pagination';
import { reasonOf } from '../common/postgres-errors';
import { ActivityEntity } from '../outbox/activity';
import { CORRELATION_HEADER, getCorrelationId, logEvent } from '../metrics/telemetry';
import { ActivityLogEntryDto, HistoryResponseDto } from './dto/history-response.dto';

// O maior limite aceito pelo GET /logs: o histórico de quase toda entidade cabe em uma página.
export const DEFAULT_HISTORY_LIMIT = 500;

/** Total informado pelo logs-service no cabeçalho, ou null se ele não vier. */
function totalFrom(headers: Record<string, unknown> | undefined): number | null {
  // O axios entrega os nomes dos cabeçalhos em minúsculas.
  const total = Number(headers?.[TOTAL_COUNT_HEADER.toLowerCase()]);
  return Number.isInteger(total) && total >= 0 ? total : null;
}

/** Única chamada HTTP síncrona entre os serviços: consulta o histórico no logs-service. */
@Injectable()
export class LogsClientService {
  constructor(private readonly http: HttpService) {}

  async getHistory(
    entityType: ActivityEntity,
    entityId: string,
    page: PageRequest = { limit: DEFAULT_HISTORY_LIMIT, offset: 0 },
  ): Promise<HistoryResponseDto> {
    const target = `logs-service/logs?entity_type=${entityType}&entity_id=${entityId}`;
    const startedAt = Date.now();
    logEvent('HTTP SYNC REQUEST', { method: 'GET', target, ...page });

    try {
      const response = await firstValueFrom(
        this.http.get<ActivityLogEntryDto[]>('/logs', {
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
      const total = totalFrom(response.headers as Record<string, unknown>);
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
