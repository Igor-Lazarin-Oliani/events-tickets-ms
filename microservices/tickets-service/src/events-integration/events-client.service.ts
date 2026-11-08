import { HttpService } from '@nestjs/axios';
import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { CORRELATION_HEADER, getCorrelationId, logEvent } from '../metrics/telemetry';

export interface EventDetails {
  id: string;
  title: string;
  category: string;
  modality: string;
  location: string;
  start_at: string;
  available_spots: number;
  status: string;
}

type HttpMethod = 'GET' | 'PATCH';

@Injectable()
export class EventsClientService {
  constructor(private readonly http: HttpService) {}

  getEventById(eventId: string): Promise<EventDetails> {
    return this.request('GET', `/events/${eventId}`);
  }

  reserveSpot(eventId: string): Promise<EventDetails> {
    return this.request('PATCH', `/events/${eventId}/reserve-spot`);
  }

  releaseSpot(eventId: string): Promise<EventDetails> {
    return this.request('PATCH', `/events/${eventId}/release-spot`);
  }

  private async request(method: HttpMethod, url: string): Promise<EventDetails> {
    const startedAt = Date.now();
    logEvent('HTTP SYNC REQUEST', { method, target: `events-service${url}` });

    try {
      const response = await firstValueFrom(
        this.http.request<EventDetails>({
          method,
          url,
          headers: { [CORRELATION_HEADER]: getCorrelationId() },
        }),
      );
      logEvent('HTTP SYNC RESPONSE', {
        method,
        target: `events-service${url}`,
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      return response.data;
    } catch (error) {
      const status = isAxiosError(error) ? error.response?.status : undefined;
      logEvent(
        'HTTP SYNC FAILURE',
        {
          method,
          target: `events-service${url}`,
          status: status ?? null,
          reason: error instanceof Error ? error.message : 'unknown error',
          duration_ms: Date.now() - startedAt,
        },
        'WARNING',
      );
      throw this.translateError(error, status);
    }
  }

  private translateError(error: unknown, status: number | undefined): HttpException {
    if (status === 404) {
      return new NotFoundException('Event not found');
    }
    if (status === 409 && isAxiosError<{ detail?: string }>(error)) {
      return new ConflictException(error.response?.data?.detail ?? 'Event is sold out');
    }
    return new ServiceUnavailableException('Events service unavailable');
  }
}
