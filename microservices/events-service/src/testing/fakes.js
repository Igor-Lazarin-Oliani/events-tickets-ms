import { QueryFailedError } from 'typeorm';
import { EventModality, EventStatus } from '../events/entities/event.entity';
import { MetricsService } from '../metrics/metrics.service';
import { ACTIVITIES_EXCHANGE, EVENTS_EXCHANGE } from '../outbox/activity';

export const EVENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
export const TICKET_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

// Sempre no ano seguinte: evento encerrado não aceita inscrições, e os testes não podem vencer.
export const FUTURE_YEAR = new Date().getUTCFullYear() + 1;
export const EVENT_START = new Date(`${FUTURE_YEAR}-11-20T12:00:00Z`);
export const EVENT_END = new Date(`${FUTURE_YEAR}-11-20T22:00:00Z`);

export function buildEvent(overrides = {}) {
  return {
    id: EVENT_ID,
    title: 'Workshop Docker',
    description: null,
    category: 'WORKSHOP',
    modality: EventModality.ONLINE,
    location: 'https://example.com/live',
    start_at: new Date(EVENT_START),
    end_at: new Date(EVENT_END),
    max_capacity: 2,
    available_spots: 2,
    status: EventStatus.PUBLISHED,
    metadata_info: null,
    created_at: new Date('2026-11-08T20:00:00Z'),
    updated_at: new Date('2026-11-08T20:00:00Z'),
    ...overrides,
  };
}

/** Erro de chave única do PostgreSQL, como o TypeORM o entrega. */
export function uniqueViolation(constraint) {
  const driverError = Object.assign(new Error('duplicate key'), { code: '23505', constraint });
  return new QueryFailedError('INSERT', [], driverError);
}

/** DataSource que executa o callback da transação com um EntityManager fictício. */
export function fakeDataSource() {
  const manager = { name: 'transaction-manager' };
  const dataSource = {
    manager: { name: 'default-manager' },
    transaction: jest.fn(async (work) => work(manager)),
  };
  return { dataSource, manager };
}

export function fakeOutbox() {
  return { enqueue: jest.fn(async () => []) };
}

/** Mensagens gravadas na outbox, na ordem em que foram enfileiradas. */
export function enqueuedMessages(outbox) {
  return outbox.enqueue.mock.calls.flatMap(([, messages]) => messages);
}

/** Só as atividades destinadas ao logs-service. */
export function enqueuedActivities(outbox) {
  return enqueuedMessages(outbox)
    .filter((message) => message.exchange === ACTIVITIES_EXCHANGE)
    .map((message) => message.payload);
}

/** Só os avisos destinados ao tickets-service. */
export function enqueuedEventNotices(outbox) {
  return enqueuedMessages(outbox)
    .filter((message) => message.exchange === EVENTS_EXCHANGE)
    .map((message) => message.payload);
}

export function fakeLogsClient() {
  return {
    getHistory: jest.fn(async (entityType, entityId, page) => ({
      entity_type: entityType,
      entity_id: entityId,
      total: 0,
      ...page,
      entries: [],
    })),
  };
}

export function metricsWithSpies() {
  const metrics = new MetricsService();
  return { metrics, spots: jest.spyOn(metrics, 'recordSpotOperation') };
}
