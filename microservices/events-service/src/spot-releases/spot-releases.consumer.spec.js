import { MetricsService } from '../metrics/metrics.service';
import { getCorrelationId } from '../metrics/telemetry';
import { EVENT_ID, TICKET_ID } from '../testing/fakes';
import { SpotReleasesConsumer } from './spot-releases.consumer';

function delivery(routingKey, body) {
  return {
    fields: { routingKey },
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function releaseMessage(overrides = {}) {
  return {
    message_id: '5a1e7c2e-9a55-4b2f-8f35-2f1b7e8a4c10',
    type: 'spot.release_requested',
    event_id: EVENT_ID,
    ticket_id: TICKET_ID,
    reason: 'ticket_cancelled',
    source: 'tickets-service',
    occurred_at: '2026-11-20T12:00:00.000Z',
    correlation_id: 'demo-123',
    ...overrides,
  };
}

function setup() {
  process.env.RABBITMQ_RETRY_DELAY_MS = '1';
  const channel = { ack: jest.fn(), nack: jest.fn() };
  let seenCorrelation;
  const eventsService = {
    releaseReservation: jest.fn(async () => {
      seenCorrelation = getCorrelationId();
      return 'success';
    }),
  };
  const metrics = new MetricsService();
  const consumed = jest.spyOn(metrics, 'recordMessageConsumed');
  const consumer = new SpotReleasesConsumer(eventsService, metrics);
  return { consumer, channel, eventsService, consumed, correlation: () => seenCorrelation };
}

describe('SpotReleasesConsumer.handleMessage', () => {
  it.each(['ticket_cancelled', 'issue_failed'])(
    'devolve a vaga (%s) e confirma depois de gravar',
    async (reason) => {
      const { consumer, channel, eventsService, consumed, correlation } = setup();

      await expect(
        consumer.handleMessage(channel, delivery('spot.release_requested', releaseMessage({ reason }))),
      ).resolves.toBe('processed');

      expect(eventsService.releaseReservation).toHaveBeenCalledWith(TICKET_ID, EVENT_ID, reason);
      expect(channel.ack).toHaveBeenCalled();
      expect(consumed).toHaveBeenCalledWith('spot.release_requested', 'processed');
      // O event.spot_released gravado leva o correlation_id do cancelamento no tickets-service.
      expect(correlation()).toBe('demo-123');
    },
  );

  it.each([
    ['JSON inválido', '{nao-e-json'],
    ['tipo diferente da routing key', releaseMessage({ type: 'ticket.cancelled' })],
    ['ticket_id que não é UUID', releaseMessage({ ticket_id: 'x' })],
    ['motivo desconhecido', releaseMessage({ reason: 'whatever' })],
  ])('manda para a DLQ: %s', async (_case, body) => {
    const { consumer, channel, eventsService } = setup();

    await expect(
      consumer.handleMessage(channel, delivery('spot.release_requested', body)),
    ).resolves.toBe('rejected');

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(eventsService.releaseReservation).not.toHaveBeenCalled();
  });

  it('devolve a mensagem à fila quando o banco falha', async () => {
    const { consumer, channel, eventsService, consumed } = setup();
    eventsService.releaseReservation.mockRejectedValue(new Error('database down'));

    await expect(
      consumer.handleMessage(channel, delivery('spot.release_requested', releaseMessage())),
    ).resolves.toBe('retried');

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledWith('spot.release_requested', 'retried');
  });
});
