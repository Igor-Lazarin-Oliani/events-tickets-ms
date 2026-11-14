import { randomUUID } from 'node:crypto';
import { getCorrelationId, SERVICE_NAME } from '../metrics/telemetry';

/** Exchange das atividades, consumidas pelo logs-service pela fila logs.activity (D20). */
export const ACTIVITIES_EXCHANGE = 'activities.exchange';
/** Exchange das mensagens do tickets-service ao events-service, como a devolução de vaga (D31). */
export const TICKETS_EXCHANGE = 'tickets.exchange';
/** Todas as exchanges em que este serviço publica; o publicador as declara ao conectar. */
export const PUBLISHED_EXCHANGES = [ACTIVITIES_EXCHANGE, TICKETS_EXCHANGE];

export const SPOT_RELEASE_REQUESTED = 'spot.release_requested';

export type ActivityLevel = 'INFO' | 'WARNING' | 'ERROR';
export type ActivityEntity = 'ticket';

/** O que aconteceu, descrito pelo serviço de domínio. Nunca inclua nome, documento ou e-mail. */
export interface Activity {
  action: string;
  entity_type: ActivityEntity;
  entity_id: string;
  message: string;
  data?: Record<string, unknown>;
  level?: ActivityLevel;
}

/** Campos comuns a toda mensagem publicada: identificação, origem e rastreio. */
export interface MessageEnvelope {
  message_id: string;
  source: string;
  occurred_at: string;
  correlation_id: string;
}

/** Corpo da atividade publicada no RabbitMQ e consumida pelo logs-service. */
export interface ActivityMessage extends MessageEnvelope {
  action: string;
  entity_type: ActivityEntity;
  entity_id: string;
  level: ActivityLevel;
  message: string;
  data: Record<string, unknown>;
}

export type SpotReleaseReason = 'ticket_cancelled' | 'issue_failed';

/** Pedido ao events-service para devolver a vaga reservada para o ingresso (D31). */
export interface SpotReleaseRequestedMessage extends MessageEnvelope {
  type: typeof SPOT_RELEASE_REQUESTED;
  event_id: string;
  ticket_id: string;
  reason: SpotReleaseReason;
}

export type OutboxPayload = ActivityMessage | SpotReleaseRequestedMessage;

/** Mensagem pronta para entrar na outbox: para onde vai e o que leva. */
export interface OutgoingMessage {
  exchange: string;
  routing_key: string;
  payload: OutboxPayload;
}

// Ações que encerram algo merecem destaque no histórico.
const WARNING_ACTIONS = new Set(['ticket.cancelled']);

function envelope(): MessageEnvelope {
  return {
    message_id: randomUUID(),
    source: SERVICE_NAME,
    occurred_at: new Date().toISOString(),
    correlation_id: getCorrelationId(),
  };
}

export function buildActivityMessage(activity: Activity): ActivityMessage {
  return {
    ...envelope(),
    action: activity.action,
    entity_type: activity.entity_type,
    entity_id: activity.entity_id,
    level: activity.level ?? (WARNING_ACTIONS.has(activity.action) ? 'WARNING' : 'INFO'),
    message: activity.message,
    data: activity.data ?? {},
  };
}

/** Atividade para o logs-service, com a ação como routing key. */
export function activityMessage(activity: Activity): OutgoingMessage {
  return {
    exchange: ACTIVITIES_EXCHANGE,
    routing_key: activity.action,
    payload: buildActivityMessage(activity),
  };
}

/**
 * Devolução de vaga. O events-service a aplica uma única vez por ingresso, pela reserva registrada
 * com o ticket_id, então pedir de novo, ou pedir sem ter reservado, não muda as vagas.
 */
export function spotReleaseRequested(
  eventId: string,
  ticketId: string,
  reason: SpotReleaseReason,
): OutgoingMessage {
  return {
    exchange: TICKETS_EXCHANGE,
    routing_key: SPOT_RELEASE_REQUESTED,
    payload: {
      ...envelope(),
      type: SPOT_RELEASE_REQUESTED,
      event_id: eventId,
      ticket_id: ticketId,
      reason,
    },
  };
}
