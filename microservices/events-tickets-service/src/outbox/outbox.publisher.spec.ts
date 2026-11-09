import { EventEmitter } from 'node:events';
import { MetricsService } from '../metrics/metrics.service';
import { fakeDataSource } from '../testing/fakes';
import { buildActivityMessage } from './activity';
import { OutboxMessage } from './entities/outbox-message.entity';
import { EXCHANGE, OutboxPublisher } from './outbox.publisher';

interface Published {
  exchange: string;
  routingKey: string;
  body: Record<string, unknown>;
  options: Record<string, unknown>;
}

class FakeChannel extends EventEmitter {
  readonly published: Published[] = [];
  readonly returnedRoutingKeys = new Set<string>();
  assertExchange = jest.fn(async () => ({ exchange: EXCHANGE }));
  waitForConfirms = jest.fn(async () => undefined);

  publish(exchange: string, routingKey: string, content: Buffer, options: Record<string, unknown>) {
    this.published.push({ exchange, routingKey, body: JSON.parse(content.toString()), options });
    if (this.returnedRoutingKeys.has(routingKey)) {
      this.emit('return', { properties: { messageId: options.messageId } });
    }
    return true;
  }
}

class FakeConnection extends EventEmitter {
  constructor(private readonly channel: FakeChannel) {
    super();
  }

  createConfirmChannel = jest.fn(async () => this.channel);
  close = jest.fn(async () => undefined);
}

function outboxMessage(action: string): OutboxMessage {
  const payload = buildActivityMessage({
    action,
    entity_type: 'ticket',
    entity_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    message: 'teste',
  });
  return Object.assign(new OutboxMessage(), {
    id: payload.message_id,
    routing_key: action,
    payload,
    published_at: null,
  });
}

function setup(pending: OutboxMessage[]) {
  const { dataSource, manager } = fakeDataSource();
  const outbox = {
    lockPending: jest.fn(async () => pending),
    markPublished: jest.fn(async () => undefined),
  };
  const metrics = new MetricsService();
  const recorded = jest.spyOn(metrics, 'recordMessagePublished');
  const channel = new FakeChannel();
  const connection = new FakeConnection(channel);
  const publisher = new OutboxPublisher(dataSource as never, outbox as never, metrics);
  const connect = jest.fn(async () => connection);
  publisher.connectionFactory = connect as never;
  return { publisher, manager, outbox, channel, connect, recorded };
}

describe('OutboxPublisher.publishPending', () => {
  it('publica com confirmação e só então marca as mensagens como publicadas', async () => {
    const messages = [outboxMessage('ticket.issued'), outboxMessage('event.spot_reserved')];
    const { publisher, manager, outbox, channel, recorded } = setup(messages);

    await expect(publisher.publishPending()).resolves.toBe(2);

    expect(channel.published.map((message) => message.routingKey)).toEqual([
      'ticket.issued',
      'event.spot_reserved',
    ]);
    expect(channel.published[0]).toMatchObject({
      exchange: EXCHANGE,
      options: { persistent: true, mandatory: true, messageId: messages[0].id },
    });
    expect(channel.waitForConfirms).toHaveBeenCalled();
    expect(outbox.markPublished).toHaveBeenCalledWith(manager, messages.map((m) => m.id));
    expect(recorded).toHaveBeenCalledWith('ticket.issued');
  });

  it('não abre conexão sem mensagens pendentes', async () => {
    const { publisher, connect } = setup([]);

    await expect(publisher.publishPending()).resolves.toBe(0);
    expect(connect).not.toHaveBeenCalled();
  });

  it('reaproveita a conexão entre os lotes', async () => {
    const { publisher, connect } = setup([outboxMessage('ticket.issued')]);

    await publisher.publishPending();
    await publisher.publishPending();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('mantém o lote pendente se o broker devolver uma mensagem sem fila ligada', async () => {
    const { publisher, outbox, channel } = setup([
      outboxMessage('ticket.issued'),
      outboxMessage('ticket.cancelled'),
    ]);
    channel.returnedRoutingKeys.add('ticket.cancelled');

    await expect(publisher.publishPending()).rejects.toThrow('queue not bound');
    expect(outbox.markPublished).not.toHaveBeenCalled();
  });

  it('mantém o lote pendente com o broker fora do ar', async () => {
    const { publisher, outbox, connect } = setup([outboxMessage('ticket.issued')]);
    connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(publisher.publishPending()).rejects.toThrow('ECONNREFUSED');
    expect(outbox.markPublished).not.toHaveBeenCalled();
  });
});

describe('buildActivityMessage', () => {
  it.each([
    ['ticket.cancelled', 'WARNING'],
    ['event.deleted', 'WARNING'],
    ['ticket.issued', 'INFO'],
  ])('define o nível de %s como %s', (action, level) => {
    expect(outboxMessage(action).payload.level).toBe(level);
  });

  it('identifica a origem e gera um message_id', () => {
    const { payload } = outboxMessage('ticket.issued');

    expect(payload.source).toBe('events-tickets-service');
    expect(payload.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.data).toEqual({});
  });
});
