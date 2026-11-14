import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Resposta do events-service à reserva: reservada, recusada (4xx) ou sem resposta definitiva. */
export type SpotReservationResult = 'reserved' | 'rejected' | 'unavailable';
/** Devolução pedida porque a emissão falhou depois da reserva: gravada na outbox ou perdida. */
export type CompensationResult = 'queued' | 'failed';
export type ConsumeResult = 'processed' | 'rejected' | 'retried';

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

  private readonly spotReservations = new Counter({
    name: 'tickets_spot_reservations_total',
    help: 'Reservas de vaga pedidas ao events-service por HTTP, por resultado.',
    labelNames: ['result'],
    registers: [this.registry],
  });

  private readonly compensations = new Counter({
    name: 'tickets_compensations_total',
    help: 'Devoluções de vaga pedidas porque a emissão falhou depois da reserva, por resultado.',
    labelNames: ['result'],
    registers: [this.registry],
  });

  private readonly messagesPublished = new Counter({
    name: 'outbox_messages_published_total',
    help: 'Mensagens confirmadas pelo RabbitMQ, por exchange e routing key.',
    labelNames: ['exchange', 'routing_key'],
    registers: [this.registry],
  });

  private readonly outboxPending = new Gauge({
    name: 'outbox_messages_pending',
    help: 'Total de mensagens da outbox aguardando publicação no RabbitMQ.',
    registers: [this.registry],
  });

  private readonly messagesConsumed = new Counter({
    name: 'integration_messages_consumed_total',
    help: 'Mensagens do events-service consumidas da fila tickets.event-updates, por resultado.',
    labelNames: ['routing_key', 'result'],
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

  recordSpotReservation(result: SpotReservationResult): void {
    this.spotReservations.inc({ result });
  }

  recordCompensation(result: CompensationResult): void {
    this.compensations.inc({ result });
  }

  recordMessagePublished(exchange: string, routingKey: string): void {
    this.messagesPublished.inc({ exchange, routing_key: routingKey });
  }

  setOutboxPending(count: number): void {
    this.outboxPending.set(count);
  }

  recordMessageConsumed(routingKey: string, result: ConsumeResult): void {
    this.messagesConsumed.inc({ routing_key: routingKey, result });
  }
}
