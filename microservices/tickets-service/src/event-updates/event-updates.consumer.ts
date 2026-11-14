import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Channel, connect, ConsumeMessage } from 'amqplib';
import { isUUID } from 'class-validator';
import { setTimeout as delay } from 'node:timers/promises';
import { reasonOf } from '../common/postgres-errors';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent, runWithCorrelationId } from '../metrics/telemetry';
import { EventClosureReason } from '../tickets/entities/closed-event.entity';
import { TicketsService } from '../tickets/tickets.service';

const DEFAULT_RABBITMQ_URL = 'amqp://events_tickets:events_tickets_pass@rabbitmq:5672/%2F';
export const EXCHANGE = 'events.exchange';
export const QUEUE = 'tickets.event-updates';
const DEAD_LETTER_EXCHANGE = 'tickets.event-updates.dlx';
const DEAD_LETTER_QUEUE = 'tickets.event-updates.dlq';
const PREFETCH = 10;

/** Routing keys tratadas e o motivo gravado nos ingressos cancelados. */
const REASONS: Record<string, EventClosureReason> = {
  'event.cancelled': 'event_cancelled',
  'event.deleted': 'event_deleted',
};

type BrokerConnection = Awaited<ReturnType<typeof connect>>;

/** Corpo publicado pelo events-service em events.exchange. */
export interface EventClosedMessage {
  message_id: string;
  type: string;
  event_id: string;
  correlation_id?: string;
}

/**
 * Consome a fila tickets.event-updates: quando o events-service cancela ou remove um evento, os
 * ingressos ativos dele são cancelados aqui (D33). Confirma (ack) só depois de gravar; mensagem
 * inválida vai para a DLQ, e falha do banco devolve a mensagem à fila depois de uma espera.
 */
@Injectable()
export class EventUpdatesConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly url = process.env.RABBITMQ_URL ?? DEFAULT_RABBITMQ_URL;
  private readonly retryMs = Number(process.env.RABBITMQ_RETRY_DELAY_MS ?? 5000);
  private connection?: BrokerConnection;
  private stopped = false;

  connectionFactory = (url: string): Promise<BrokerConnection> => connect(url, { timeout: 3000 });

  constructor(
    private readonly ticketsService: TicketsService,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    // Sem await: a API síncrona deve subir mesmo com o broker indisponível.
    void this.connectWithRetry();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.connection?.close().catch(() => undefined);
  }

  async handleMessage(channel: Channel, message: ConsumeMessage | null): Promise<string> {
    if (!message) {
      return 'ignored';
    }
    const routingKey = message.fields.routingKey;
    const payload = this.parse(message);
    if (!payload) {
      logEvent('EVENT MESSAGE REJECTED', { routing_key: routingKey }, 'WARNING');
      this.metrics.recordMessageConsumed(routingKey, 'rejected');
      channel.nack(message, false, false);
      return 'rejected';
    }

    return runWithCorrelationId(payload.correlation_id ?? '-', async () => {
      logEvent('EVENT MESSAGE RECEIVED', {
        routing_key: routingKey,
        event_id: payload.event_id,
        message_id: payload.message_id,
      });
      try {
        await this.ticketsService.cancelAllForEvent(payload.event_id, REASONS[routingKey]);
      } catch (error) {
        logEvent(
          'EVENT MESSAGE RETRY',
          { routing_key: routingKey, event_id: payload.event_id, reason: reasonOf(error) },
          'WARNING',
        );
        this.metrics.recordMessageConsumed(routingKey, 'retried');
        // A espera evita um laço de reentrega enquanto o banco estiver indisponível.
        await delay(this.retryMs);
        channel.nack(message, false, true);
        return 'retried';
      }
      this.metrics.recordMessageConsumed(routingKey, 'processed');
      channel.ack(message);
      return 'processed';
    });
  }

  private parse(message: ConsumeMessage): EventClosedMessage | undefined {
    const routingKey = message.fields.routingKey;
    if (!(routingKey in REASONS)) {
      return undefined;
    }
    try {
      const body = JSON.parse(message.content.toString()) as Partial<EventClosedMessage>;
      // O tipo no corpo é a própria routing key; divergência indica mensagem malformada.
      const valid =
        body.type === routingKey &&
        typeof body.event_id === 'string' &&
        isUUID(body.event_id) &&
        typeof body.message_id === 'string';
      return valid ? (body as EventClosedMessage) : undefined;
    } catch {
      return undefined;
    }
  }

  private async connectWithRetry(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.startConsuming();
        return;
      } catch (error) {
        logEvent(
          'RABBITMQ CONNECTION FAILED',
          { reason: reasonOf(error), retry_in_ms: this.retryMs },
          'WARNING',
        );
        await this.connection?.close().catch(() => undefined);
        this.connection = undefined;
        await delay(this.retryMs);
      }
    }
  }

  private async startConsuming(): Promise<void> {
    const connection = await this.connectionFactory(this.url);
    this.connection = connection;
    // Só uma conexão que chegou a consumir reconecta ao cair; falhas na subida ficam com o laço
    // do connectWithRetry, para não haver dois laços de reconexão.
    let consuming = false;
    // Sem ouvinte de "error", uma falha do broker derrubaria o processo.
    connection.on('error', (error: Error) => {
      logEvent('RABBITMQ CONNECTION ERROR', { reason: error.message }, 'WARNING');
    });
    connection.once('close', () => {
      this.connection = undefined;
      if (!this.stopped && consuming) {
        logEvent('RABBITMQ CONNECTION LOST', { queue: QUEUE }, 'WARNING');
        void delay(this.retryMs).then(() => this.connectWithRetry());
      }
    });

    const channel = await connection.createChannel();
    channel.on('error', (error: Error) => {
      logEvent('RABBITMQ CHANNEL ERROR', { reason: error.message }, 'WARNING');
      connection.close().catch(() => undefined);
    });
    await this.declareTopology(channel);
    await channel.prefetch(PREFETCH);
    await channel.consume(QUEUE, (message) => {
      this.handleMessage(channel, message).catch((error: unknown) => {
        // Sem confirmação, o RabbitMQ reentrega a mensagem ao reconectar.
        logEvent('EVENT MESSAGE HANDLING FAILED', { reason: reasonOf(error) }, 'WARNING');
      });
    });
    consuming = true;
    logEvent('RABBITMQ CONSUMER READY', { queue: QUEUE, bindings: Object.keys(REASONS) });
  }

  /** O consumidor declara a própria fila: o publicador só conhece a exchange. */
  private async declareTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', { durable: true });
    await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');
    await channel.assertQueue(QUEUE, { durable: true, deadLetterExchange: DEAD_LETTER_EXCHANGE });
    for (const routingKey of Object.keys(REASONS)) {
      await channel.bindQueue(QUEUE, EXCHANGE, routingKey);
    }
  }
}
