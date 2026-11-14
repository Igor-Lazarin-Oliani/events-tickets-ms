import { EventEmitter } from 'node:events';
import { MetricsService } from '../metrics/metrics.service';
import { EVENT_ID, fakeDataSource } from '../testing/fakes';
import {
  ACTIVITIES_EXCHANGE,
  activityMessage,
  buildActivityMessage,
  eventClosed,
  EVENTS_EXCHANGE,
  PUBLISHED_EXCHANGES,
} from './activity';
import { BATCH_SIZE, OutboxPublisher } from './outbox.publisher';

class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.published = [];
    this.returnedRoutingKeys = new Set();
    this.assertExchange = jest.fn(async (exchange) => ({ exchange }));
    this.waitForConfirms = jest.fn(async () => undefined);
  }

  publish(exchange, routingKey, content, options) {
    this.published.push({ exchange, routingKey, body: JSON.parse(content.toString()), options });
    if (this.returnedRoutingKeys.has(`${exchange}:${routingKey}`)) {
      this.emit('return', { properties: { messageId: options.messageId } });
    }
    return true;
  }
}

class FakeConnection extends EventEmitter {
  constructor(channel) {
    super();
    this.createConfirmChannel = jest.fn(async () => channel);
    this.close = jest.fn(async () => undefined);
  }
}

function row(message) {
  return {
    id: message.payload.message_id,
    exchange: message.exchange,
    routing_key: message.routing_key,
    payload: message.payload,
    published_at: null,
  };
}

const activityRow = (action) =>
  row(activityMessage({ action, entity_type: 'event', entity_id: EVENT_ID, message: 'teste' }));

function setup(pending, totalPending = pending.length) {
  const { dataSource, manager } = fakeDataSource();
  const outbox = {
    countPending: jest.fn(async () => totalPending),
    lockPending: jest.fn(async () => pending),
    markPublished: jest.fn(async () => undefined),
  };
  const metrics = new MetricsService();
  const recorded = jest.spyOn(metrics, 'recordMessagePublished');
  const gauge = jest.spyOn(metrics, 'setOutboxPending');
  const channel = new FakeChannel();
  const connection = new FakeConnection(channel);
  const publisher = new OutboxPublisher(dataSource, outbox, metrics);
  const connect = jest.fn(async () => connection);
  publisher.connectionFactory = connect;
  return { publisher, dataSource, manager, outbox, channel, connection, connect, recorded, gauge };
}

const batchOf = (size) => Array.from({ length: size }, () => activityRow('event.updated'));

describe('OutboxPublisher.publishPending', () => {
  it('publica cada mensagem na sua exchange, com confirmação, e só então as marca', async () => {
    const messages = [activityRow('event.cancelled'), row(eventClosed('event.cancelled', EVENT_ID))];
    const { publisher, manager, outbox, channel, recorded } = setup(messages);

    await expect(publisher.publishPending()).resolves.toEqual({ published: 2, returned: 0 });

    expect(channel.published.map(({ exchange, routingKey }) => [exchange, routingKey])).toEqual([
      [ACTIVITIES_EXCHANGE, 'event.cancelled'],
      [EVENTS_EXCHANGE, 'event.cancelled'],
    ]);
    expect(channel.published[1].options).toMatchObject({
      persistent: true,
      mandatory: true,
      messageId: messages[1].id,
    });
    expect(channel.published[1].body).toMatchObject({ type: 'event.cancelled', event_id: EVENT_ID });
    expect(outbox.markPublished).toHaveBeenCalledWith(manager, messages.map((m) => m.id));
    expect(recorded).toHaveBeenCalledWith(EVENTS_EXCHANGE, 'event.cancelled');
  });

  it('declara as exchanges em que publica ao conectar', async () => {
    const { publisher, channel } = setup([activityRow('event.created')]);

    await publisher.publishPending();

    expect(channel.assertExchange.mock.calls.map(([exchange]) => exchange)).toEqual(
      PUBLISHED_EXCHANGES,
    );
  });

  it('não abre conexão sem mensagens pendentes', async () => {
    const { publisher, connect } = setup([]);

    await expect(publisher.publishPending()).resolves.toEqual({ published: 0, returned: 0 });
    expect(connect).not.toHaveBeenCalled();
  });

  it('mantém pendente só o aviso devolvido por falta de fila do tickets-service', async () => {
    const activity = activityRow('event.deleted');
    const notice = row(eventClosed('event.deleted', EVENT_ID));
    const { publisher, manager, outbox, channel } = setup([activity, notice]);
    channel.returnedRoutingKeys.add(`${EVENTS_EXCHANGE}:event.deleted`);

    await expect(publisher.publishPending()).resolves.toEqual({ published: 1, returned: 1 });
    expect(outbox.markPublished).toHaveBeenCalledWith(manager, [activity.id]);
  });

  it('mantém o lote pendente com o broker fora do ar, sem abrir transação', async () => {
    const { publisher, dataSource, outbox, connect } = setup([activityRow('event.created')]);
    connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(publisher.publishPending()).rejects.toThrow('ECONNREFUSED');
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(outbox.markPublished).not.toHaveBeenCalled();
  });

  it('informa na métrica todo o acúmulo da outbox, e não só o lote', async () => {
    const { publisher, gauge } = setup(batchOf(50), 120);

    await publisher.publishPending();

    expect(gauge.mock.calls.map(([count]) => count)).toEqual([120, 70]);
  });
});

describe('OutboxPublisher.runCycle', () => {
  it('busca o próximo lote em seguida quando o lote veio cheio', async () => {
    const { publisher } = setup(batchOf(BATCH_SIZE), BATCH_SIZE * 3);

    await expect(publisher.runCycle()).resolves.toBe(0);
  });

  it('espera o intervalo normal quando o lote não veio cheio', async () => {
    const { publisher } = setup([activityRow('event.created')]);

    await expect(publisher.runCycle()).resolves.toBe(1000);
  });

  it('espera mais antes de reenviar uma mensagem devolvida', async () => {
    const { publisher, channel } = setup([row(eventClosed('event.cancelled', EVENT_ID))]);
    channel.returnedRoutingKeys.add(`${EVENTS_EXCHANGE}:event.cancelled`);

    await expect(publisher.runCycle()).resolves.toBe(5000);
  });

  it('sobrevive à falha do broker, fecha a conexão e espera antes de tentar de novo', async () => {
    const { publisher, channel, connection } = setup([activityRow('event.created')]);
    channel.waitForConfirms.mockRejectedValue(new Error('channel closed'));

    await expect(publisher.runCycle()).resolves.toBe(5000);
    expect(connection.close).toHaveBeenCalled();
  });
});

describe('buildActivityMessage', () => {
  it.each([
    ['event.cancelled', 'WARNING'],
    ['event.deleted', 'WARNING'],
    ['event.spot_reserved', 'INFO'],
  ])('define o nível de %s como %s', (action, level) => {
    expect(
      buildActivityMessage({ action, entity_type: 'event', entity_id: EVENT_ID, message: 'x' }).level,
    ).toBe(level);
  });
});
