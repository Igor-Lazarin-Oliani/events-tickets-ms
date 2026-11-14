import { MetricsService } from '../metrics/metrics.service';
import { getCorrelationId } from '../metrics/telemetry';
import { EVENT_ID } from '../testing/fakes';
import { EventUpdatesConsumer } from './event-updates.consumer';

function delivery(routingKey: string, body: unknown) {
  return {
    fields: { routingKey },
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  } as never;
}

function eventMessage(type: string, overrides: Record<string, unknown> = {}) {
  return {
    message_id: '5a1e7c2e-9a55-4b2f-8f35-2f1b7e8a4c10',
    type,
    event_id: EVENT_ID,
    source: 'events-service',
    occurred_at: '2026-11-20T12:00:00.000Z',
    correlation_id: 'demo-123',
    ...overrides,
  };
}

function setup() {
  process.env.RABBITMQ_RETRY_DELAY_MS = '1';
  const channel = { ack: jest.fn(), nack: jest.fn() };
  let seenCorrelation: string | undefined;
  const ticketsService = {
    cancelAllForEvent: jest.fn(async () => {
      seenCorrelation = getCorrelationId();
      return 2;
    }),
  };
  const metrics = new MetricsService();
  const consumed = jest.spyOn(metrics, 'recordMessageConsumed');
  const consumer = new EventUpdatesConsumer(ticketsService as never, metrics);
  return { consumer, channel, ticketsService, consumed, correlation: () => seenCorrelation };
}

describe('EventUpdatesConsumer.handleMessage', () => {
  it.each([
    ['event.cancelled', 'event_cancelled'],
    ['event.deleted', 'event_deleted'],
  ])('cancela os ingressos em %s e confirma depois de gravar', async (routingKey, reason) => {
    const { consumer, channel, ticketsService, consumed, correlation } = setup();

    await expect(
      consumer.handleMessage(channel as never, delivery(routingKey, eventMessage(routingKey))),
    ).resolves.toBe('processed');

    expect(ticketsService.cancelAllForEvent).toHaveBeenCalledWith(EVENT_ID, reason);
    expect(channel.ack).toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledWith(routingKey, 'processed');
    // Os ticket.cancelled gravados levam o correlation_id da operação original no events-service.
    expect(correlation()).toBe('demo-123');
  });

  it.each([
    ['JSON inválido', 'event.cancelled', '{nao-e-json'],
    ['tipo diferente da routing key', 'event.cancelled', eventMessage('event.deleted')],
    ['event_id que não é UUID', 'event.cancelled', eventMessage('event.cancelled', { event_id: 'x' })],
    ['routing key não tratada', 'event.created', eventMessage('event.created')],
  ])('manda para a DLQ: %s', async (_case, routingKey, body) => {
    const { consumer, channel, ticketsService } = setup();

    await expect(consumer.handleMessage(channel as never, delivery(routingKey, body))).resolves.toBe(
      'rejected',
    );

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(ticketsService.cancelAllForEvent).not.toHaveBeenCalled();
  });

  it('devolve a mensagem à fila quando o banco falha', async () => {
    const { consumer, channel, ticketsService, consumed } = setup();
    ticketsService.cancelAllForEvent.mockRejectedValue(new Error('database down'));

    await expect(
      consumer.handleMessage(channel as never, delivery('event.cancelled', eventMessage('event.cancelled'))),
    ).resolves.toBe('retried');

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledWith('event.cancelled', 'retried');
  });
});
