import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AxiosError, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { runWithCorrelationId } from '../metrics/telemetry';
import { EVENT_ID, reservedEvent, TICKET_ID } from '../testing/fakes';
import { EventsClientService, EventsServiceUnavailableError } from './events-client.service';

function setup() {
  const http = { patch: jest.fn() };
  return { http, client: new EventsClientService(http as never) };
}

function httpError(status: number, message: unknown) {
  return throwError(
    () =>
      new AxiosError('failed', undefined, undefined, undefined, {
        status,
        data: { statusCode: status, message },
      } as AxiosResponse),
  );
}

describe('EventsClientService.reserveSpot', () => {
  it('chama a rota interna com o ticket_id e repassa o X-Correlation-Id', async () => {
    const { http, client } = setup();
    http.patch.mockReturnValue(of({ status: 200, data: reservedEvent() }));

    const event = await runWithCorrelationId('demo-123', () =>
      client.reserveSpot(EVENT_ID, TICKET_ID),
    );

    expect(event).toEqual(reservedEvent());
    expect(http.patch).toHaveBeenCalledWith(
      `/events/${EVENT_ID}/reserve-spot`,
      { ticket_id: TICKET_ID },
      { headers: { 'X-Correlation-Id': 'demo-123' } },
    );
  });

  it.each([
    [404, 'Event not found', NotFoundException],
    [400, 'Event has already ended', BadRequestException],
    [409, 'Event is sold out', ConflictException],
  ])('repassa o %s do events-service com a mesma mensagem', async (status, message, type) => {
    const { http, client } = setup();
    http.patch.mockReturnValue(httpError(status, message));

    const error = await client.reserveSpot(EVENT_ID, TICKET_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(type);
    expect((error as Error).message).toBe(message);
  });

  it('junta a lista de mensagens de validação em um texto', async () => {
    const { http, client } = setup();
    http.patch.mockReturnValue(httpError(400, ['ticket_id must be a UUID', 'outro erro']));

    await expect(client.reserveSpot(EVENT_ID, TICKET_ID)).rejects.toThrow(
      'ticket_id must be a UUID; outro erro',
    );
  });

  it('traduz erro 5xx para resposta indefinida (503)', async () => {
    const { http, client } = setup();
    http.patch.mockReturnValue(httpError(500, 'Internal server error'));

    await expect(client.reserveSpot(EVENT_ID, TICKET_ID)).rejects.toBeInstanceOf(
      EventsServiceUnavailableError,
    );
  });

  it('traduz timeout, sem resposta HTTP, para resposta indefinida (503)', async () => {
    const { http, client } = setup();
    http.patch.mockReturnValue(throwError(() => new AxiosError('timeout', 'ECONNABORTED')));

    await expect(client.reserveSpot(EVENT_ID, TICKET_ID)).rejects.toThrow(
      'Events service unavailable',
    );
  });
});
