import { Dependencies, Injectable } from '@nestjs/common';
import { connect } from 'amqplib';
import { DataSource } from 'typeorm';
import { reasonOf } from '../common/postgres-errors';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent, runWithCorrelationId } from '../metrics/telemetry';
import { ACTIVITIES_EXCHANGE, PUBLISHED_EXCHANGES } from './activity';
import { OutboxRepository } from './outbox.repository';

const DEFAULT_RABBITMQ_URL = 'amqp://events_tickets:events_tickets_pass@rabbitmq:5672/%2F';
export const BATCH_SIZE = 50;
const CONNECT_TIMEOUT_MS = 3000;
const CONFIRM_TIMEOUT_MS = 5000;

function withTimeout(promise, timeoutMs, reason) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Publica em segundo plano as mensagens pendentes da outbox, em lotes de BATCH_SIZE, cada uma na
 * sua exchange. A entrega é "ao menos uma vez": uma falha no meio do lote reenvia o lote inteiro,
 * e os consumidores descartam repetições.
 */
@Injectable()
@Dependencies(DataSource, OutboxRepository, MetricsService)
export class OutboxPublisher {
  constructor(dataSource, outbox, metrics) {
    this.dataSource = dataSource;
    this.outbox = outbox;
    this.metrics = metrics;
    this.url = process.env.RABBITMQ_URL ?? DEFAULT_RABBITMQ_URL;
    this.pollMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);
    this.retryMs = Number(process.env.RABBITMQ_RETRY_DELAY_MS ?? 5000);
    this.returned = new Set();
    this.connection = undefined;
    this.channel = undefined;
    this.timer = undefined;
    this.stopped = false;
    this.connectionFactory = (url) => connect(url, { timeout: CONNECT_TIMEOUT_MS });
  }

  onApplicationBootstrap() {
    // Sem await: a API síncrona deve subir mesmo com o broker indisponível.
    this.schedule(this.pollMs);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.closeConnection();
  }

  /** Publica um lote de até BATCH_SIZE mensagens: { published, returned }. */
  async publishPending() {
    // A métrica mostra todo o acúmulo, e não só o lote, inclusive com o broker fora do ar.
    const pending = await this.outbox.countPending();
    this.metrics.setOutboxPending(pending);
    if (pending === 0) {
      return { published: 0, returned: 0 };
    }

    // Conecta antes de abrir a transação: a espera pela rede não segura uma conexão do banco
    // nem deixa linhas da outbox travadas.
    const channel = await this.getChannel();
    const { published, returned } = await this.dataSource.transaction(async (manager) => {
      const batch = await this.outbox.lockPending(manager, BATCH_SIZE);
      if (batch.length === 0) {
        return { published: [], returned: [] };
      }
      const returnedIds = await this.publishBatch(channel, batch);
      // Só a devolvida continua pendente: uma fila que ainda não existe não segura as demais.
      const confirmed = batch.filter((message) => !returnedIds.has(message.id));
      await this.outbox.markPublished(
        manager,
        confirmed.map((message) => message.id),
      );
      return {
        published: confirmed,
        returned: batch.filter((message) => returnedIds.has(message.id)),
      };
    });

    this.metrics.setOutboxPending(Math.max(0, pending - published.length));
    for (const message of published) {
      this.metrics.recordMessagePublished(message.exchange, message.routing_key);
      this.logMessage(
        message.exchange === ACTIVITIES_EXCHANGE
          ? 'ACTIVITY MESSAGE PUBLISHED'
          : 'INTEGRATION MESSAGE PUBLISHED',
        message,
      );
    }
    for (const message of returned) {
      this.logMessage('MESSAGE RETURNED', message, 'WARNING');
    }
    return { published: published.length, returned: returned.length };
  }

  /**
   * Um ciclo do laço: publica um lote e devolve a espera até o próximo. Lote cheio indica que
   * ainda há pendentes, e o próximo sai em seguida; mensagem devolvida espera a fila ser criada.
   */
  async runCycle() {
    try {
      const { published, returned } = await this.publishPending();
      if (published + returned >= BATCH_SIZE) {
        return 0;
      }
      return returned > 0 ? this.retryMs : this.pollMs;
    } catch (error) {
      // O laço precisa sobreviver a qualquer falha do broker ou do banco.
      logEvent(
        'MESSAGE PUBLISH FAILED',
        { reason: reasonOf(error), retry_in_ms: this.retryMs },
        'WARNING',
      );
      await this.closeConnection();
      return this.retryMs;
    }
  }

  /** Publica o lote e devolve os ids das mensagens que o broker não conseguiu entregar a uma fila. */
  async publishBatch(channel, messages) {
    this.returned.clear();
    for (const message of messages) {
      // "mandatory" faz o broker devolver a mensagem se ainda não houver fila ligada a ela.
      channel.publish(
        message.exchange,
        message.routing_key,
        Buffer.from(JSON.stringify(message.payload)),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId: message.id,
          correlationId: message.payload.correlation_id,
        },
      );
    }
    await withTimeout(channel.waitForConfirms(), CONFIRM_TIMEOUT_MS, 'broker confirmation timeout');
    // O broker envia a devolução antes da confirmação; aqui ela já foi registrada.
    return new Set(this.returned);
  }

  logMessage(tag, message, level = 'INFO') {
    runWithCorrelationId(message.payload.correlation_id ?? '-', () =>
      logEvent(
        tag,
        {
          exchange: message.exchange,
          routing_key: message.routing_key,
          entity_id: message.payload.entity_id ?? message.payload.event_id,
          message_id: message.id,
        },
        level,
      ),
    );
  }

  async getChannel() {
    if (this.channel) {
      return this.channel;
    }
    const connection = await this.connectionFactory(this.url);
    // Sem ouvinte de "error", uma falha do broker derrubaria o processo.
    connection.on('error', (error) => {
      logEvent('RABBITMQ CONNECTION ERROR', { reason: error.message }, 'WARNING');
    });
    connection.once('close', () => {
      this.connection = undefined;
      this.channel = undefined;
    });

    const channel = await connection.createConfirmChannel();
    channel.on('error', (error) => {
      logEvent('RABBITMQ CHANNEL ERROR', { reason: error.message }, 'WARNING');
    });
    channel.once('close', () => {
      this.channel = undefined;
    });
    channel.on('return', (message) => {
      this.returned.add(String(message.properties.messageId));
    });
    for (const exchange of PUBLISHED_EXCHANGES) {
      await channel.assertExchange(exchange, 'topic', { durable: true });
    }

    this.connection = connection;
    this.channel = channel;
    logEvent('RABBITMQ PUBLISHER READY', { exchanges: PUBLISHED_EXCHANGES });
    return channel;
  }

  schedule(delayMs) {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  async tick() {
    this.schedule(await this.runCycle());
  }

  async closeConnection() {
    const connection = this.connection;
    this.connection = undefined;
    this.channel = undefined;
    await connection?.close().catch(() => undefined);
  }
}
