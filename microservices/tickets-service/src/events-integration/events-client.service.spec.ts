import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { EventsClientService } from './events-client.service';

const EVENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function httpError(status: number, data: unknown = {}): AxiosError {
  return new AxiosError('failed', undefined, undefined, undefined, {
    status,
    data,
  } as AxiosResponse);
}

function setup() {
  const http = { request: jest.fn() };
  return { http, client: new EventsClientService(http as never) };
}

describe('EventsClientService', () => {
  it.each([
    ['getEventById', 'GET', `/events/${EVENT_ID}`],
    ['reserveSpot', 'PATCH', `/events/${EVENT_ID}/reserve-spot`],
    ['releaseSpot', 'PATCH', `/events/${EVENT_ID}/release-spot`],
  ] as const)('%s chama %s %s', async (operation, method, url) => {
    const { http, client } = setup();
    http.request.mockReturnValue(of({ status: 200, data: { id: EVENT_ID } }));

    await expect(client[operation](EVENT_ID)).resolves.toEqual({ id: EVENT_ID });
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({ method, url }));
  });

  it('traduz 404 para NotFoundException', async () => {
    const { http, client } = setup();
    http.request.mockReturnValue(throwError(() => httpError(404)));

    await expect(client.getEventById(EVENT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('repassa o motivo do 409 do events-service', async () => {
    const { http, client } = setup();
    http.request.mockReturnValue(
      throwError(() => httpError(409, { detail: 'Event is not open for registrations' })),
    );

    await expect(client.reserveSpot(EVENT_ID)).rejects.toThrow(
      new ConflictException('Event is not open for registrations'),
    );
  });

  it('traduz 500 para indisponibilidade', async () => {
    const { http, client } = setup();
    http.request.mockReturnValue(throwError(() => httpError(500)));

    await expect(client.reserveSpot(EVENT_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('traduz timeout, sem resposta HTTP, para indisponibilidade', async () => {
    const { http, client } = setup();
    http.request.mockReturnValue(throwError(() => new AxiosError('timeout', 'ECONNABORTED')));

    await expect(client.releaseSpot(EVENT_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
