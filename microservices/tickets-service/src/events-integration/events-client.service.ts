import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { reasonOf } from '../common/postgres-errors';
import { CORRELATION_HEADER, getCorrelationId, logEvent } from '../metrics/telemetry';

export const EVENT_NOT_FOUND = 'Event not found';
export const EVENTS_SERVICE_UNAVAILABLE = 'Events service unavailable';

/** Evento devolvido pelo events-service depois da reserva, já com as vagas atualizadas. */
export interface ReservedEvent {
  id: string;
  title: string;
  category: string;
  modality: string;
  location: string;
  start_at: string;
  end_at: string;
  max_capacity: number;
  available_spots: number;
  status: string;
}

/**
 * O events-service não deu uma resposta definitiva (timeout, erro 5xx ou fora do ar): a reserva
 * pode ter acontecido ou não. Quem recebe este erro pede a devolução da vaga, que é idempotente.
 */
export class EventsServiceUnavailableError extends ServiceUnavailableException {
  constructor() {
    super(EVENTS_SERVICE_UNAVAILABLE);
  }
}

/** Mensagem de erro do NestJS do events-service: texto ou lista de textos. */
function messageOf(data: unknown, fallback: string): string {
  const message = (data as { message?: unknown } | undefined)?.message;
  if (Array.isArray(message)) {
    return message.join('; ');
  }
  return typeof message === 'string' && message ? message : fallback;
}

/** Chamada HTTP síncrona do tickets-service ao events-service: a reserva da vaga (D30). */
@Injectable()
export class EventsClientService {
  constructor(private readonly http: HttpService) {}

  /**
   * Reserva uma vaga para o ingresso. O ticket_id é a chave de idempotência: repetir a chamada com o
   * mesmo id não reserva outra vaga.
   */
  async reserveSpot(eventId: string, ticketId: string): Promise<ReservedEvent> {
    const path = `/events/${eventId}/reserve-spot`;
    const target = `events-service${path}`;
    const startedAt = Date.now();
    logEvent('HTTP SYNC REQUEST', { method: 'PATCH', target, ticket_id: ticketId });

    try {
      const response = await firstValueFrom(
        this.http.patch<ReservedEvent>(
          path,
          { ticket_id: ticketId },
          { headers: { [CORRELATION_HEADER]: getCorrelationId() } },
        ),
      );
      logEvent('HTTP SYNC RESPONSE', {
        method: 'PATCH',
        target,
        status: response.status,
        available_spots: response.data.available_spots,
        duration_ms: Date.now() - startedAt,
      });
      return response.data;
    } catch (error) {
      const status = isAxiosError(error) ? error.response?.status : undefined;
      logEvent(
        'HTTP SYNC FAILURE',
        {
          method: 'PATCH',
          target,
          status: status ?? null,
          reason: reasonOf(error),
          duration_ms: Date.now() - startedAt,
        },
        'WARNING',
      );
      throw this.translateError(error, status);
    }
  }

  /** As recusas do events-service chegam ao cliente com o mesmo código e a mesma mensagem. */
  private translateError(error: unknown, status: number | undefined): HttpException {
    const data = isAxiosError(error) ? error.response?.data : undefined;
    if (status === 404) {
      return new NotFoundException(messageOf(data, EVENT_NOT_FOUND));
    }
    if (status === 400) {
      return new BadRequestException(messageOf(data, 'Event is not open for registrations'));
    }
    if (status === 409) {
      return new ConflictException(messageOf(data, 'Event is sold out'));
    }
    return new EventsServiceUnavailableError();
  }
}
