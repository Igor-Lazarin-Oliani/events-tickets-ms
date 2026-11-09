import { HttpService } from '@nestjs/axios';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { reasonOf } from '../common/postgres-errors';
import { ActivityEntity } from '../outbox/activity';
import { CORRELATION_HEADER, getCorrelationId, logEvent } from '../metrics/telemetry';
import { ActivityLogEntryDto, HistoryResponseDto } from './dto/history-response.dto';

const HISTORY_LIMIT = 500;

/** Única chamada HTTP síncrona entre os serviços: consulta o histórico no logs-service. */
@Injectable()
export class LogsClientService {
  constructor(private readonly http: HttpService) {}

  async getHistory(entityType: ActivityEntity, entityId: string): Promise<HistoryResponseDto> {
    const target = `logs-service/logs?entity_type=${entityType}&entity_id=${entityId}`;
    const startedAt = Date.now();
    logEvent('HTTP SYNC REQUEST', { method: 'GET', target });

    try {
      const response = await firstValueFrom(
        this.http.get<ActivityLogEntryDto[]>('/logs', {
          params: {
            entity_type: entityType,
            entity_id: entityId,
            order: 'asc',
            limit: HISTORY_LIMIT,
          },
          headers: { [CORRELATION_HEADER]: getCorrelationId() },
        }),
      );
      logEvent('HTTP SYNC RESPONSE', {
        method: 'GET',
        target,
        status: response.status,
        entries: response.data.length,
        duration_ms: Date.now() - startedAt,
      });
      return { entity_type: entityType, entity_id: entityId, entries: response.data };
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
