import { Dependencies, Injectable } from '@nestjs/common';
import { connect } from 'amqplib';
import { isUUID } from 'class-validator';
import { setTimeout as delay } from 'node:timers/promises';
import { reasonOf } from '../common/postgres-errors';
import { EventsService } from '../events/events.service';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent, runWithCorrelationId } from '../metrics/telemetry';

const DEFAULT_RABBITMQ_URL = 'amqp://events_tickets:events_tickets_pass@rabbitmq:5672/%2F';
export const EXCHANGE = 'tickets.exchange';
export const QUEUE = 'events.spot-releases';
export const ROUTING_KEY = 'spot.release_requested';
const DEAD_LETTER_EXCHANGE = 'events.spot-releases.dlx';
const DEAD_LETTER_QUEUE = 'events.spot-releases.dlq';
const REASONS = new Set(['ticket_cancelled', 'issue_failed']);
const PREFETCH = 10;

/**
 * Consome a fila events.spot-releases: o tickets-service pede a devolução da vaga ao cancelar um
 * ingresso ou quando a emissão falha depois da reserva (D31). Confirma (ack) só depois de gravar;
 * mensagem inválida vai para a DLQ, e falha do banco devolve a mensagem à fila depois de uma espera.
 */
@Injectable()
@Dependencies(EventsService, MetricsService)
export class SpotReleasesConsumer {
  constructor(eventsService, metrics) {
    this.eventsService = eventsService;
    this.metrics = metrics;
    this.url = process.env.RABBITMQ_URL ?? DEFAULT_RABBITMQ_URL;
    this.retryMs = Number(process.env.RABBITMQ_RETRY_DELAY_MS ?? 5000);
    this.connection = undefined;
    this.stopped = false;
    this.connectionFactory = (url) => connect(url, { timeout: 3000 });
  }

  onApplicationBootstrap() {
    // Sem await: a API síncrona deve subir mesmo com o broker indisponível.
    void this.connectWithRetry();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    await this.connection?.close().catch(() => undefined);
  }

  async handleMessage(channel, message) {
    if (!message) {
      return 'ignored';
    }
    const routingKey = message.fields.routingKey;
    const payload = this.parse(message);
    if (!payload) {
      logEvent('SPOT RELEASE MESSAGE REJECTED', { routing_key: routingKey }, 'WARNING');
      this.metrics.recordMessageConsumed(routingKey, 'rejected');
      channel.nack(message, false, false);
      return 'rejected';
    }

    return runWithCorrelationId(payload.correlation_id ?? '-', async () => {
      logEvent('SPOT RELEASE MESSAGE RECEIVED', {
        routing_key: routingKey,
        event_id: payload.event_id,
        ticket_id: payload.ticket_id,
        reason: payload.reason,
        message_id: payload.message_id,
      });
      try {
        await this.eventsService.releaseReservation(
          payload.ticket_id,
          payload.event_id,
          payload.reason,
        );
      } catch (error) {
        logEvent(
          'SPOT RELEASE MESSAGE RETRY',
          { ticket_id: payload.ticket_id, reason: reasonOf(error) },
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

  parse(message) {
    if (message.fields.routingKey !== ROUTING_KEY) {
      return undefined;
    }
    try {
      const body = JSON.parse(message.content.toString());
      // O tipo no corpo é a própria routing key; divergência indica mensagem malformada.
      const valid =
        body.type === ROUTING_KEY &&
        typeof body.message_id === 'string' &&
        isUUID(String(body.event_id)) &&
        isUUID(String(body.ticket_id)) &&
        REASONS.has(body.reason);
      return valid ? body : undefined;
    } catch {
      return undefined;
    }
  }

  async connectWithRetry() {
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

  async startConsuming() {
    const connection = await this.connectionFactory(this.url);
    this.connection = connection;
    // Só uma conexão que chegou a consumir reconecta ao cair; falhas na subida ficam com o laço
    // do connectWithRetry, para não haver dois laços de reconexão.
    let consuming = false;
    // Sem ouvinte de "error", uma falha do broker derrubaria o processo.
    connection.on('error', (error) => {
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
    channel.on('error', (error) => {
      logEvent('RABBITMQ CHANNEL ERROR', { reason: error.message }, 'WARNING');
      connection.close().catch(() => undefined);
    });
    await this.declareTopology(channel);
    await channel.prefetch(PREFETCH);
    await channel.consume(QUEUE, (message) => {
      this.handleMessage(channel, message).catch((error) => {
        // Sem confirmação, o RabbitMQ reentrega a mensagem ao reconectar.
        logEvent('SPOT RELEASE MESSAGE HANDLING FAILED', { reason: reasonOf(error) }, 'WARNING');
      });
    });
    consuming = true;
    logEvent('RABBITMQ CONSUMER READY', { queue: QUEUE, bindings: [ROUTING_KEY] });
  }

  /** O consumidor declara a própria fila: o publicador só conhece a exchange. */
  async declareTopology(channel) {
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', { durable: true });
    await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');
    await channel.assertQueue(QUEUE, { durable: true, deadLetterExchange: DEAD_LETTER_EXCHANGE });
    await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
  }
}
