import { ServiceUnavailableException } from '@nestjs/common';
import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import { runWithCorrelationId } from '../metrics/telemetry';
import { EVENT_ID } from '../testing/fakes';
import { LogsClientService } from './logs-client.service';

function setup() {
  const http = { get: jest.fn() };
  return { http, client: new LogsClientService(http) };
}

describe('LogsClientService.getHistory', () => {
  it('consulta GET /logs em ordem cronológica e repassa o X-Correlation-Id', async () => {
    const { http, client } = setup();
    const entries = [{ id: '1', action: 'event.created' }];
    http.get.mockReturnValue(of({ status: 200, data: entries, headers: { 'x-total-count': '1' } }));

    const history = await runWithCorrelationId('demo-123', () => client.getHistory('event', EVENT_ID));

    expect(history).toEqual({
      entity_type: 'event',
      entity_id: EVENT_ID,
      total: 1,
      limit: 500,
      offset: 0,
      entries,
    });
    expect(http.get).toHaveBeenCalledWith(
      '/logs',
      expect.objectContaining({
        params: { entity_type: 'event', entity_id: EVENT_ID, order: 'asc', limit: 500, offset: 0 },
        headers: { 'X-Correlation-Id': 'demo-123' },
      }),
    );
  });

  it('devolve total null quando o logs-service não informa o cabeçalho', async () => {
    const { http, client } = setup();
    http.get.mockReturnValue(of({ status: 200, data: [], headers: {} }));

    await expect(client.getHistory('event', EVENT_ID)).resolves.toMatchObject({ total: null });
  });

  it('traduz erro HTTP ou timeout do logs-service para 503', async () => {
    const { http, client } = setup();
    http.get.mockReturnValue(throwError(() => new AxiosError('timeout', 'ECONNABORTED')));

    await expect(client.getHistory('event', EVENT_ID)).rejects.toThrow(
      new ServiceUnavailableException('Logs service unavailable'),
    );
  });
});
