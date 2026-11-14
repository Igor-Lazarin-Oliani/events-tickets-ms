import { EventEmitter } from 'node:events';
import { MetricsService } from '../metrics/metrics.service';
import { fakeDataSource, EVENT_ID, TICKET_ID } from '../testing/fakes';
import {
  ACTIVITIES_EXCHANGE,
  activityMessage,
  buildActivityMessage,
  OutgoingMessage,
  PUBLISHED_EXCHANGES,
  spotReleaseRequested,
  TICKETS_EXCHANGE,
} from './activity';
import { OutboxMessage } from './entities/outbox-message.entity';
import { BATCH_SIZE, OutboxPublisher } from './outbox.publisher';

interface Published {
  exchange: string;
  routingKey: string;
  body: Record<string, unknown>;
  options: Record<string, unknown>;
}

class FakeChannel extends EventEmitter {
  readonly published: Published[] = [];
  readonly returnedRoutingKeys = new Set<string>();
  assertExchange = jest.fn(async (exchange: string) => ({ exchange }));
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

function row(message: OutgoingMessage): OutboxMessage {
  return Object.assign(new OutboxMessage(), {
    id: message.payload.message_id,
    exchange: message.exchange,
    routing_key: message.routing_key,
    payload: message.payload,
    published_at: null,
  });
}

function activityRow(action: string): OutboxMessage {
  return row(
    activityMessage({ action, entity_type: 'ticket', entity_id: TICKET_ID, message: 'teste' }),
  );
}

function setup(pending: OutboxMessage[], totalPending = pending.length) {
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
  const publisher = new OutboxPublisher(dataSource as never, outbox as never, metrics);
  const connect = jest.fn(async () => connection);
  publisher.connectionFactory = connect as never;
  return { publisher, dataSource, manager, outbox, channel, connection, connect, recorded, gauge };
}

const batchOf = (size: number) => Array.from({ length: size }, () => activityRow('ticket.issued'));

describe('OutboxPublisher.publishPending', () => {
  it('publica cada mensagem na sua exchange, com confirmação, e só então as marca', async () => {
    const messages = [
      activityRow('ticket.cancelled'),
      row(spotReleaseRequested(EVENT_ID, TICKET_ID, 'ticket_cancelled')),
    ];
    const { publisher, manager, outbox, channel, recorded } = setup(messages);

    await expect(publisher.publishPending()).resolves.toEqual({ published: 2, returned: 0 });

    expect(channel.published.map(({ exchange, routingKey }) => [exchange, routingKey])).toEqual([
      [ACTIVITIES_EXCHANGE, 'ticket.cancelled'],
      [TICKETS_EXCHANGE, 'spot.release_requested'],
    ]);
    expect(channel.published[0].options).toMatchObject({
      persistent: true,
      mandatory: true,
      messageId: messages[0].id,
    });
    expect(channel.waitForConfirms).toHaveBeenCalled();
    expect(outbox.markPublished).toHaveBeenCalledWith(manager, messages.map((m) => m.id));
    expect(recorded).toHaveBeenCalledWith(TICKETS_EXCHANGE, 'spot.release_requested');
  });

  it('declara as exchanges em que publica ao conectar', async () => {
    const { publisher, channel } = setup([activityRow('ticket.issued')]);

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

  it('reaproveita a conexão entre os lotes', async () => {
    const { publisher, connect } = setup([activityRow('ticket.issued')]);

    await publisher.publishPending();
    await publisher.publishPending();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('mantém pendente só a mensagem devolvida por falta de fila, e marca as demais', async () => {
    const issued = activityRow('ticket.issued');
    const release = row(spotReleaseRequested(EVENT_ID, TICKET_ID, 'issue_failed'));
    const { publisher, manager, outbox, channel } = setup([issued, release]);
    channel.returnedRoutingKeys.add('spot.release_requested');

    await expect(publisher.publishPending()).resolves.toEqual({ published: 1, returned: 1 });
    expect(outbox.markPublished).toHaveBeenCalledWith(manager, [issued.id]);
  });

  it('mantém o lote pendente com o broker fora do ar, sem abrir transação', async () => {
    const { publisher, dataSource, outbox, connect } = setup([activityRow('ticket.issued')]);
    connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(publisher.publishPending()).rejects.toThrow('ECONNREFUSED');
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(outbox.lockPending).not.toHaveBeenCalled();
    expect(outbox.markPublished).not.toHaveBeenCalled();
  });

  it('conecta ao broker antes de abrir a transação que trava as mensagens', async () => {
    const { publisher, dataSource, connect } = setup([activityRow('ticket.issued')]);

    await publisher.publishPending();

    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(
      dataSource.transaction.mock.invocationCallOrder[0],
    );
  });

  it('informa na métrica todo o acúmulo da outbox, e não só o lote', async () => {
    const { publisher, gauge } = setup(batchOf(50), 120);

    await expect(publisher.publishPending()).resolves.toEqual({ published: 50, returned: 0 });

    expect(gauge.mock.calls.map(([count]) => count)).toEqual([120, 70]);
  });

  it('mantém na métrica o acúmulo enquanto o broker está fora do ar', async () => {
    const { publisher, connect, gauge } = setup(batchOf(50), 120);
    connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(publisher.publishPending()).rejects.toThrow('ECONNREFUSED');

    expect(gauge.mock.calls.map(([count]) => count)).toEqual([120]);
  });
});

describe('OutboxPublisher.runCycle', () => {
  const pollMs = 1000;
  const retryMs = 5000;

  it('busca o próximo lote em seguida quando o lote veio cheio', async () => {
    const { publisher } = setup(batchOf(BATCH_SIZE), BATCH_SIZE * 3);

    await expect(publisher.runCycle()).resolves.toBe(0);
  });

  it('espera o intervalo normal quando o lote não veio cheio', async () => {
    const { publisher } = setup([activityRow('ticket.issued')]);

    await expect(publisher.runCycle()).resolves.toBe(pollMs);
  });

  it('espera o intervalo normal sem mensagens pendentes', async () => {
    const { publisher } = setup([]);

    await expect(publisher.runCycle()).resolves.toBe(pollMs);
  });

  it('espera mais antes de reenviar uma mensagem devolvida', async () => {
    const { publisher, channel } = setup([row(spotReleaseRequested(EVENT_ID, TICKET_ID, 'issue_failed'))]);
    channel.returnedRoutingKeys.add('spot.release_requested');

    await expect(publisher.runCycle()).resolves.toBe(retryMs);
  });

  it('sobrevive à falha do broker, fecha a conexão e espera antes de tentar de novo', async () => {
    const { publisher, channel, connection } = setup([activityRow('ticket.issued')]);
    channel.waitForConfirms.mockRejectedValue(new Error('channel closed'));

    await expect(publisher.runCycle()).resolves.toBe(retryMs);
    expect(connection.close).toHaveBeenCalled();
  });
});

describe('buildActivityMessage', () => {
  it.each([
    ['ticket.cancelled', 'WARNING'],
    ['ticket.issued', 'INFO'],
    ['ticket.checked_in', 'INFO'],
  ])('define o nível de %s como %s', (action, level) => {
    expect(
      buildActivityMessage({ action, entity_type: 'ticket', entity_id: TICKET_ID, message: 'x' })
        .level,
    ).toBe(level);
  });

  it('identifica a origem e gera um message_id', () => {
    const payload = buildActivityMessage({
      action: 'ticket.issued',
      entity_type: 'ticket',
      entity_id: TICKET_ID,
      message: 'x',
    });

    expect(payload.source).toBe('tickets-service');
    expect(payload.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.data).toEqual({});
  });
});
