import { Event, EventModality, EventStatus } from '../events/entities/event.entity';
import { MetricsService } from '../metrics/metrics.service';
import { Activity } from '../outbox/activity';

export const EVENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
export const TICKET_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

export function buildEvent(overrides: Partial<Event> = {}): Event {
  return Object.assign(new Event(), {
    id: EVENT_ID,
    title: 'Workshop Docker',
    description: null,
    category: 'WORKSHOP',
    modality: EventModality.ONLINE,
    location: 'https://example.com/live',
    start_at: new Date('2026-11-20T12:00:00Z'),
    end_at: new Date('2026-11-20T22:00:00Z'),
    max_capacity: 2,
    available_spots: 2,
    status: EventStatus.PUBLISHED,
    metadata_info: null,
    created_at: new Date('2026-11-08T20:00:00Z'),
    updated_at: new Date('2026-11-08T20:00:00Z'),
    ...overrides,
  });
}

/** DataSource que executa o callback da transação com um EntityManager fictício. */
export function fakeDataSource() {
  const manager = { name: 'transaction-manager' };
  const dataSource = {
    transaction: jest.fn(async (work: (entityManager: unknown) => unknown) => work(manager)),
  };
  return { dataSource, manager };
}

export function fakeOutbox() {
  return { enqueue: jest.fn(async (_manager: unknown, _activities: Activity[]) => []) };
}

/** Atividades gravadas na outbox, na ordem em que foram enfileiradas. */
export function enqueuedActivities(outbox: ReturnType<typeof fakeOutbox>): Activity[] {
  return outbox.enqueue.mock.calls.flatMap(([, activities]) => activities);
}

export function fakeLogsClient() {
  return {
    getHistory: jest.fn(async (entityType: string, entityId: string) => ({
      entity_type: entityType,
      entity_id: entityId,
      entries: [],
    })),
  };
}

export function metricsWithSpies() {
  const metrics = new MetricsService();
  return {
    metrics,
    issued: jest.spyOn(metrics, 'incrementTicketsIssued'),
    cancelled: jest.spyOn(metrics, 'incrementTicketsCancelled'),
    spots: jest.spyOn(metrics, 'recordSpotOperation'),
  };
}
