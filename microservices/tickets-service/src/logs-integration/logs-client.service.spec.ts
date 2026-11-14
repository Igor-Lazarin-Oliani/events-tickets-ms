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
    http.get.mockReturnValue(of({ status: 200, data: entries, headers: { 'x-total-count': '1' } }));

    const history = await runWithCorrelationId('demo-123', () =>
      client.getHistory('ticket', TICKET_ID),
    );

    expect(history).toEqual({
      entity_type: 'ticket',
      entity_id: TICKET_ID,
      total: 1,
      limit: 500,
      offset: 0,
      entries,
    });
    expect(http.get).toHaveBeenCalledWith(
      '/logs',
      expect.objectContaining({
        params: {
          entity_type: 'ticket',
          entity_id: TICKET_ID,
          order: 'asc',
          limit: 500,
          offset: 0,
        },
        headers: { 'X-Correlation-Id': 'demo-123' },
      }),
    );
  });

  it('repassa a página pedida e informa o total, para o cliente saber que há mais', async () => {
    const { http, client } = setup();
    const entries = Array.from({ length: 2 }, (_, index) => ({ id: String(index) }));
    http.get.mockReturnValue(of({ status: 200, data: entries, headers: { 'x-total-count': '7' } }));

    const history = await client.getHistory('ticket', TICKET_ID, { limit: 2, offset: 4 });

    expect(history).toMatchObject({ total: 7, limit: 2, offset: 4 });
    expect(http.get.mock.calls[0][1].params).toMatchObject({ limit: 2, offset: 4 });
  });

  it('devolve total null quando o logs-service não informa o cabeçalho', async () => {
    const { http, client } = setup();
    http.get.mockReturnValue(of({ status: 200, data: [], headers: {} }));

    await expect(client.getHistory('ticket', TICKET_ID)).resolves.toMatchObject({ total: null });
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

    await expect(client.getHistory('ticket', TICKET_ID)).rejects.toThrow(
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
