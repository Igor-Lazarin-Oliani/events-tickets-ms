import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfirmChannel, connect, Message } from 'amqplib';
import { DataSource } from 'typeorm';
import { reasonOf } from '../common/postgres-errors';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent, runWithCorrelationId } from '../metrics/telemetry';
import { OutboxMessage } from './entities/outbox-message.entity';
import { OutboxRepository } from './outbox.repository';

const DEFAULT_RABBITMQ_URL = 'amqp://events_tickets:events_tickets_pass@rabbitmq:5672/%2F';
export const EXCHANGE = 'events-tickets.exchange';
const BATCH_SIZE = 50;
const CONNECT_TIMEOUT_MS = 3000;
const CONFIRM_TIMEOUT_MS = 5000;

type BrokerConnection = Awaited<ReturnType<typeof connect>>;
export type ConnectionFactory = (url: string) => Promise<BrokerConnection>;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Publica em segundo plano as mensagens pendentes da outbox. A entrega é "ao menos uma vez":
 * uma falha no meio do lote reenvia o lote inteiro, e o logs-service descarta repetições.
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly url = process.env.RABBITMQ_URL ?? DEFAULT_RABBITMQ_URL;
  private readonly pollMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);
  private readonly retryMs = Number(process.env.RABBITMQ_RETRY_DELAY_MS ?? 5000);
  private readonly returned = new Set<string>();
  private connection?: BrokerConnection;
  private channel?: ConfirmChannel;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  connectionFactory: ConnectionFactory = (url) => connect(url, { timeout: CONNECT_TIMEOUT_MS });

  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxRepository,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    // Sem await: a API síncrona deve subir mesmo com o broker indisponível.
    this.schedule(this.pollMs);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.closeConnection();
  }

  async publishPending(): Promise<number> {
    const published = await this.dataSource.transaction(async (manager) => {
      const pending = await this.outbox.lockPending(manager, BATCH_SIZE);
      this.metrics.setOutboxPending(pending.length);
      if (pending.length === 0) {
        return pending;
      }
      await this.publishBatch(pending);
      await this.outbox.markPublished(
        manager,
        pending.map((message) => message.id),
      );
      return pending;
    });

    if (published.length > 0) {
      this.metrics.setOutboxPending(0);
    }
    for (const message of published) {
      this.metrics.recordMessagePublished(message.routing_key);
      runWithCorrelationId(message.payload.correlation_id ?? '-', () =>
        logEvent('ACTIVITY MESSAGE PUBLISHED', {
          routing_key: message.routing_key,
          entity_id: message.payload.entity_id,
          message_id: message.id,
        }),
      );
    }
    return published.length;
  }

  private async publishBatch(messages: OutboxMessage[]): Promise<void> {
    const channel = await this.getChannel();
    this.returned.clear();
    for (const message of messages) {
      // "mandatory" faz o broker devolver a mensagem se ainda não houver fila ligada a ela.
      channel.publish(EXCHANGE, message.routing_key, Buffer.from(JSON.stringify(message.payload)), {
        persistent: true,
        mandatory: true,
        contentType: 'application/json',
        messageId: message.id,
        correlationId: message.payload.correlation_id,
      });
    }
    await withTimeout(channel.waitForConfirms(), CONFIRM_TIMEOUT_MS, 'broker confirmation timeout');
    // O broker envia a devolução antes da confirmação; aqui ela já foi registrada.
    if (this.returned.size > 0) {
      throw new Error(`${this.returned.size} message(s) returned: queue not bound yet`);
    }
  }

  private async getChannel(): Promise<ConfirmChannel> {
    if (this.channel) {
      return this.channel;
    }
    const connection = await this.connectionFactory(this.url);
    // Sem ouvinte de "error", uma falha do broker derrubaria o processo.
    connection.on('error', (error: Error) => {
      logEvent('RABBITMQ CONNECTION ERROR', { reason: error.message }, 'WARNING');
    });
    connection.once('close', () => {
      this.connection = undefined;
      this.channel = undefined;
    });

    const channel = await connection.createConfirmChannel();
    channel.on('error', (error: Error) => {
      logEvent('RABBITMQ CHANNEL ERROR', { reason: error.message }, 'WARNING');
    });
    channel.once('close', () => {
      this.channel = undefined;
    });
    channel.on('return', (message: Message) => {
      this.returned.add(String(message.properties.messageId));
    });
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

    this.connection = connection;
    this.channel = channel;
    logEvent('RABBITMQ PUBLISHER READY', { exchange: EXCHANGE });
    return channel;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    let nextDelay = this.pollMs;
    try {
      await this.publishPending();
    } catch (error) {
      // O laço precisa sobreviver a qualquer falha do broker ou do banco.
      nextDelay = this.retryMs;
      logEvent(
        'ACTIVITY MESSAGE PUBLISH FAILED',
        { reason: reasonOf(error), retry_in_ms: this.retryMs },
        'WARNING',
      );
      await this.closeConnection();
    }
    this.schedule(nextDelay);
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.channel = undefined;
    await connection?.close().catch(() => undefined);
  }
}
