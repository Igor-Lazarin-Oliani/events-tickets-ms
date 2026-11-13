import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export type SpotOperation = 'reserve' | 'release';
export type SpotResult = 'success' | 'conflict' | 'at_capacity' | 'event_missing';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  private readonly httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'Total de requisições HTTP recebidas.',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });

  private readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Latência das requisições HTTP, em segundos.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly ticketsIssued = new Counter({
    name: 'tickets_issued_total',
    help: 'Total de ingressos emitidos.',
    registers: [this.registry],
  });

  private readonly ticketsCancelled = new Counter({
    name: 'tickets_cancelled_total',
    help: 'Total de ingressos cancelados, inclusive pelo cancelamento ou remoção do evento.',
    registers: [this.registry],
  });

  private readonly spotOperations = new Counter({
    name: 'events_spot_operations_total',
    help: 'Reservas e devoluções de vagas, por resultado.',
    labelNames: ['operation', 'result'],
    registers: [this.registry],
  });

  private readonly messagesPublished = new Counter({
    name: 'outbox_messages_published_total',
    help: 'Mensagens de atividade confirmadas pelo RabbitMQ, por routing key.',
    labelNames: ['routing_key'],
    registers: [this.registry],
  });

  private readonly outboxPending = new Gauge({
    name: 'outbox_messages_pending',
    help: 'Total de mensagens da outbox aguardando publicação no RabbitMQ.',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  recordHttpRequest(method: string, route: string, status: number, durationSeconds: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSeconds);
  }

  incrementTicketsIssued(): void {
    this.ticketsIssued.inc();
  }

  incrementTicketsCancelled(amount = 1): void {
    this.ticketsCancelled.inc(amount);
  }

  recordSpotOperation(operation: SpotOperation, result: SpotResult): void {
    this.spotOperations.inc({ operation, result });
  }

  recordMessagePublished(routingKey: string): void {
    this.messagesPublished.inc({ routing_key: routingKey });
  }

  setOutboxPending(count: number): void {
    this.outboxPending.set(count);
  }
}
