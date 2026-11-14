import { ReservedEvent } from '../events-integration/events-client.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  ACTIVITIES_EXCHANGE,
  ActivityMessage,
  OutgoingMessage,
  TICKETS_EXCHANGE,
} from '../outbox/activity';

export const EVENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
export const TICKET_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

// Sempre no ano seguinte, para as datas dos testes não vencerem.
export const FUTURE_YEAR = new Date().getUTCFullYear() + 1;
export const EVENT_START = `${FUTURE_YEAR}-11-20T12:00:00.000Z`;

/** Evento como o events-service o devolve depois da reserva (JSON, datas em texto). */
export function reservedEvent(overrides: Partial<ReservedEvent> = {}): ReservedEvent {
  return {
    id: EVENT_ID,
    title: 'Workshop Docker',
    category: 'WORKSHOP',
    modality: 'ONLINE',
    location: 'https://example.com/live',
    start_at: EVENT_START,
    end_at: `${FUTURE_YEAR}-11-20T22:00:00.000Z`,
    max_capacity: 2,
    available_spots: 1,
    status: 'PUBLISHED',
    ...overrides,
  };
}

/** DataSource que executa o callback da transação com um EntityManager fictício. */
export function fakeDataSource() {
  const manager = { name: 'transaction-manager' };
  const dataSource = {
    manager: { name: 'default-manager' },
    transaction: jest.fn(async (work: (entityManager: unknown) => unknown) => work(manager)),
  };
  return { dataSource, manager };
}

export function fakeOutbox() {
  return { enqueue: jest.fn(async (_manager: unknown, _messages: OutgoingMessage[]) => []) };
}

/** Mensagens gravadas na outbox, na ordem em que foram enfileiradas. */
export function enqueuedMessages(outbox: ReturnType<typeof fakeOutbox>): OutgoingMessage[] {
  return outbox.enqueue.mock.calls.flatMap(([, messages]) => messages);
}

/** Só as atividades destinadas ao logs-service. */
export function enqueuedActivities(outbox: ReturnType<typeof fakeOutbox>): ActivityMessage[] {
  return enqueuedMessages(outbox)
    .filter((message) => message.exchange === ACTIVITIES_EXCHANGE)
    .map((message) => message.payload as ActivityMessage);
}

/** Só os pedidos de devolução de vaga destinados ao events-service. */
export function enqueuedSpotReleases(outbox: ReturnType<typeof fakeOutbox>) {
  return enqueuedMessages(outbox)
    .filter((message) => message.exchange === TICKETS_EXCHANGE)
    .map((message) => message.payload);
}

export function fakeLogsClient() {
  return {
    getHistory: jest.fn(
      async (entityType: string, entityId: string, page: { limit: number; offset: number }) => ({
        entity_type: entityType,
        entity_id: entityId,
        total: 0,
        ...page,
        entries: [],
      }),
    ),
  };
}

export function metricsWithSpies() {
  const metrics = new MetricsService();
  return {
    metrics,
    issued: jest.spyOn(metrics, 'incrementTicketsIssued'),
    cancelled: jest.spyOn(metrics, 'incrementTicketsCancelled'),
    reservations: jest.spyOn(metrics, 'recordSpotReservation'),
    compensations: jest.spyOn(metrics, 'recordCompensation'),
  };
}
