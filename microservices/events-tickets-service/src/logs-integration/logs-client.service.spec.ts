import { ServiceUnavailableException } from '@nestjs/common';
import { AxiosError, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { runWithCorrelationId } from '../metrics/telemetry';
import { LogsClientService } from './logs-client.service';

const TICKET_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function setup() {
  const http = { get: jest.fn() };
  return { http, client: new LogsClientService(http as never) };
}

describe('LogsClientService.getHistory', () => {
  it('consulta GET /logs em ordem cronológica e repassa o X-Correlation-Id', async () => {
    const { http, client } = setup();
    const entries = [{ id: '1', action: 'ticket.issued' }];
    http.get.mockReturnValue(of({ status: 200, data: entries }));

    const history = await runWithCorrelationId('demo-123', () =>
      client.getHistory('ticket', TICKET_ID),
    );

    expect(history).toEqual({ entity_type: 'ticket', entity_id: TICKET_ID, entries });
    expect(http.get).toHaveBeenCalledWith(
      '/logs',
      expect.objectContaining({
        params: expect.objectContaining({
          entity_type: 'ticket',
          entity_id: TICKET_ID,
          order: 'asc',
        }),
        headers: { 'X-Correlation-Id': 'demo-123' },
      }),
    );
  });

  it('traduz erro HTTP do logs-service para 503', async () => {
    const { http, client } = setup();
    http.get.mockReturnValue(
      throwError(
        () =>
          new AxiosError('failed', undefined, undefined, undefined, {
            status: 500,
            data: {},
          } as AxiosResponse),
      ),
    );

    await expect(client.getHistory('event', TICKET_ID)).rejects.toThrow(
      new ServiceUnavailableException('Logs service unavailable'),
    );
  });

  it('traduz timeout, sem resposta HTTP, para 503', async () => {
    const { http, client } = setup();
    http.get.mockReturnValue(throwError(() => new AxiosError('timeout', 'ECONNABORTED')));

    await expect(client.getHistory('ticket', TICKET_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
