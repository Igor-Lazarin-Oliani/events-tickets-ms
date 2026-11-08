import { Channel, ConsumeMessage } from 'amqplib';
import { MetricsService } from '../metrics/metrics.service';
import { EventMessagesConsumer } from './event-messages.consumer';

const EVENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function messageOf(body: unknown, routingKey = 'event.cancelled'): ConsumeMessage {
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  return { content: Buffer.from(content), fields: { routingKey } } as unknown as ConsumeMessage;
}

function setup() {
  process.env.RABBITMQ_RETRY_DELAY_MS = '0';
  const ticketsService = { cancelAllForEvent: jest.fn(async () => 2) };
  const channel = { ack: jest.fn(), nack: jest.fn() };
  const metrics = new MetricsService();
  const recorded = jest.spyOn(metrics, 'recordEventMessage');
  const consumer = new EventMessagesConsumer(ticketsService as never, metrics);
  return { consumer, ticketsService, channel, recorded };
}

describe('EventMessagesConsumer.handleMessage', () => {
  it.each(['event.cancelled', 'event.deleted'])(
    'cancela os ingressos e confirma a mensagem %s',
    async (routingKey) => {
      const { consumer, ticketsService, channel, recorded } = setup();
      const message = messageOf({ event_id: EVENT_ID }, routingKey);

      await consumer.handleMessage(channel as unknown as Channel, message);

      expect(ticketsService.cancelAllForEvent).toHaveBeenCalledWith(EVENT_ID);
      expect(channel.ack).toHaveBeenCalledWith(message);
      expect(channel.nack).not.toHaveBeenCalled();
      expect(recorded).toHaveBeenCalledWith(routingKey, 'processed');
    },
  );

  it.each([
    ['JSON inválido', 'nao-e-json'],
    ['sem event_id', { outro: 1 }],
    ['event_id inválido', { event_id: 'abc' }],
  ])('envia para a fila de mensagens mortas: %s', async (_, body) => {
    const { consumer, ticketsService, channel, recorded } = setup();
    const message = messageOf(body);

    await consumer.handleMessage(channel as unknown as Channel, message);

    expect(ticketsService.cancelAllForEvent).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    expect(recorded).toHaveBeenCalledWith('event.cancelled', 'rejected');
  });

  it('recusa routing key desconhecida', async () => {
    const { consumer, ticketsService, channel } = setup();
    const message = messageOf({ event_id: EVENT_ID }, 'event.unknown');

    await consumer.handleMessage(channel as unknown as Channel, message);

    expect(ticketsService.cancelAllForEvent).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
  });

  it('devolve a mensagem para a fila se o banco falhar', async () => {
    const { consumer, ticketsService, channel, recorded } = setup();
    ticketsService.cancelAllForEvent.mockRejectedValue(new Error('database down'));
    const message = messageOf({ event_id: EVENT_ID });

    await consumer.handleMessage(channel as unknown as Channel, message);

    expect(channel.nack).toHaveBeenCalledWith(message, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(recorded).toHaveBeenCalledWith('event.cancelled', 'retried');
  });

  it('ignora o cancelamento do consumidor pelo broker', async () => {
    const { consumer, channel } = setup();

    await expect(
      consumer.handleMessage(channel as unknown as Channel, null),
    ).resolves.toBeUndefined();
    expect(channel.ack).not.toHaveBeenCalled();
  });
});
