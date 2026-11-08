import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Channel, connect, ConsumeMessage } from 'amqplib';
import { isUUID } from 'class-validator';
import { setTimeout as delay } from 'node:timers/promises';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent, runWithCorrelationId } from '../metrics/telemetry';
import { TicketsService } from '../tickets/tickets.service';

const DEFAULT_RABBITMQ_URL = 'amqp://events_tickets:events_tickets_pass@rabbitmq:5672/%2F';
const EXCHANGE = 'events.exchange';
const QUEUE = 'tickets.event-updates';
const DEAD_LETTER_EXCHANGE = 'tickets.event-updates.dlx';
const DEAD_LETTER_QUEUE = 'tickets.event-updates.dlq';
const HANDLED_ROUTING_KEYS = ['event.cancelled', 'event.deleted'];
const PREFETCH = 10;

type BrokerConnection = Awaited<ReturnType<typeof connect>>;

interface EventMessage {
  event_id: string;
  correlation_id?: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

@Injectable()
export class EventMessagesConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly url = process.env.RABBITMQ_URL ?? DEFAULT_RABBITMQ_URL;
  private readonly retryDelayMs = Number(process.env.RABBITMQ_RETRY_DELAY_MS ?? 5000);
  private connection?: BrokerConnection;
  private stopped = false;

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

  async handleMessage(channel: Channel, message: ConsumeMessage | null): Promise<void> {
    if (!message) {
      return;
    }
    const routingKey = message.fields.routingKey;
    const payload = this.parse(message);
    if (!payload) {
      logEvent('EVENT MESSAGE REJECTED', { routing_key: routingKey }, 'WARNING');
      this.metrics.recordEventMessage(routingKey, 'rejected');
      channel.nack(message, false, false);
      return;
    }

    await runWithCorrelationId(payload.correlation_id ?? '-', async () => {
      logEvent('EVENT MESSAGE RECEIVED', { routing_key: routingKey, event_id: payload.event_id });
      try {
        await this.ticketsService.cancelAllForEvent(payload.event_id);
      } catch (error) {
        logEvent(
          'EVENT MESSAGE RETRY',
          { routing_key: routingKey, event_id: payload.event_id, reason: reasonOf(error) },
          'WARNING',
        );
        this.metrics.recordEventMessage(routingKey, 'retried');
        // A espera evita um laço de reentrega enquanto o banco estiver indisponível.
        await delay(this.retryDelayMs);
        channel.nack(message, false, true);
        return;
      }
      this.metrics.recordEventMessage(routingKey, 'processed');
      channel.ack(message);
    });
  }

  private parse(message: ConsumeMessage): EventMessage | undefined {
    if (!HANDLED_ROUTING_KEYS.includes(message.fields.routingKey)) {
      return undefined;
    }
    try {
      const body = JSON.parse(message.content.toString()) as Partial<EventMessage>;
      return typeof body.event_id === 'string' && isUUID(body.event_id)
        ? (body as EventMessage)
        : undefined;
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
          { reason: reasonOf(error), retry_in_ms: this.retryDelayMs },
          'WARNING',
        );
        await delay(this.retryDelayMs);
      }
    }
  }

  private async startConsuming(): Promise<void> {
    const connection = await connect(this.url);
    this.connection = connection;
    // Sem ouvinte de "error", uma falha do broker derrubaria o processo.
    connection.on('error', (error: Error) => {
      logEvent('RABBITMQ CONNECTION ERROR', { reason: error.message }, 'WARNING');
    });
    connection.once('close', () => {
      if (!this.stopped) {
        logEvent('RABBITMQ CONNECTION LOST', {}, 'WARNING');
        void this.connectWithRetry();
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
    logEvent('RABBITMQ CONSUMER READY', { queue: QUEUE });
  }

  private async declareTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', { durable: true });
    await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');
    await channel.assertQueue(QUEUE, { durable: true, deadLetterExchange: DEAD_LETTER_EXCHANGE });
    for (const routingKey of HANDLED_ROUTING_KEYS) {
      await channel.bindQueue(QUEUE, EXCHANGE, routingKey);
    }
  }
}
