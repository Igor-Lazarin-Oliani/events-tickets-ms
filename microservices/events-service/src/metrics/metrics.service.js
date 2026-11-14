import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Métricas no formato Prometheus. Reserva: success, replayed (mesmo ticket_id de novo) ou conflict.
 * Devolução: success, at_capacity, event_missing, not_reserved (nada a devolver) ou duplicate.
 */
@Injectable()
export class MetricsService {
  constructor() {
    this.registry = new Registry();
    const registers = [this.registry];

    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Total de requisições HTTP recebidas.',
      labelNames: ['method', 'route', 'status'],
      registers,
    });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Latência das requisições HTTP, em segundos.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.spotOperations = new Counter({
      name: 'events_spot_operations_total',
      help: 'Reservas e devoluções de vagas, por resultado.',
      labelNames: ['operation', 'result'],
      registers,
    });
    this.messagesPublished = new Counter({
      name: 'outbox_messages_published_total',
      help: 'Mensagens confirmadas pelo RabbitMQ, por exchange e routing key.',
      labelNames: ['exchange', 'routing_key'],
      registers,
    });
    this.outboxPending = new Gauge({
      name: 'outbox_messages_pending',
      help: 'Total de mensagens da outbox aguardando publicação no RabbitMQ.',
      registers,
    });
    this.messagesConsumed = new Counter({
      name: 'integration_messages_consumed_total',
      help: 'Mensagens do tickets-service consumidas da fila events.spot-releases, por resultado.',
      labelNames: ['routing_key', 'result'],
      registers,
    });

    collectDefaultMetrics({ register: this.registry });
  }

  get contentType() {
    return this.registry.contentType;
  }

  render() {
    return this.registry.metrics();
  }

  recordHttpRequest(method, route, status, durationSeconds) {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSeconds);
  }

  recordSpotOperation(operation, result) {
    this.spotOperations.inc({ operation, result });
  }

  recordMessagePublished(exchange, routingKey) {
    this.messagesPublished.inc({ exchange, routing_key: routingKey });
  }

  setOutboxPending(count) {
    this.outboxPending.set(count);
  }

  recordMessageConsumed(routingKey, result) {
    this.messagesConsumed.inc({ routing_key: routingKey, result });
  }
}
