import { randomUUID } from 'node:crypto';
import { getCorrelationId, SERVICE_NAME } from '../metrics/telemetry';

/** Exchange das atividades, consumidas pelo logs-service pela fila logs.activity (D20). */
export const ACTIVITIES_EXCHANGE = 'activities.exchange';
/** Exchange dos avisos do events-service ao tickets-service: evento cancelado ou removido (D33). */
export const EVENTS_EXCHANGE = 'events.exchange';
/** Todas as exchanges em que este serviço publica; o publicador as declara ao conectar. */
export const PUBLISHED_EXCHANGES = [ACTIVITIES_EXCHANGE, EVENTS_EXCHANGE];

// Ações que encerram algo merecem destaque no histórico.
const WARNING_ACTIONS = new Set(['event.cancelled', 'event.deleted']);

/** Campos comuns a toda mensagem publicada: identificação, origem e rastreio. */
function envelope() {
  return {
    message_id: randomUUID(),
    source: SERVICE_NAME,
    occurred_at: new Date().toISOString(),
    correlation_id: getCorrelationId(),
  };
}

/**
 * Corpo da atividade consumida pelo logs-service. activity: { action, entity_type, entity_id,
 * message, data?, level? }.
 */
export function buildActivityMessage(activity) {
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
export function activityMessage(activity) {
  return {
    exchange: ACTIVITIES_EXCHANGE,
    routing_key: activity.action,
    payload: buildActivityMessage(activity),
  };
}

/**
 * Aviso ao tickets-service de que o evento não aceita mais inscrições: ele cancela os ingressos
 * ativos ao consumir. type é event.cancelled ou event.deleted.
 */
export function eventClosed(type, eventId) {
  return {
    exchange: EVENTS_EXCHANGE,
    routing_key: type,
    payload: { ...envelope(), type, event_id: eventId },
  };
}
