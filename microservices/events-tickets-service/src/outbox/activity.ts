import { randomUUID } from 'node:crypto';
import { getCorrelationId, SERVICE_NAME } from '../metrics/telemetry';

export type ActivityLevel = 'INFO' | 'WARNING' | 'ERROR';
export type ActivityEntity = 'event' | 'ticket';

/** O que aconteceu, descrito pelo serviço de domínio. Nunca inclua documento ou e-mail. */
export interface Activity {
  action: string;
  entity_type: ActivityEntity;
  entity_id: string;
  message: string;
  data?: Record<string, unknown>;
  level?: ActivityLevel;
}

/** Corpo da mensagem publicada no RabbitMQ e consumida pelo logs-service. */
export interface ActivityMessage {
  message_id: string;
  action: string;
  entity_type: ActivityEntity;
  entity_id: string;
  level: ActivityLevel;
  message: string;
  data: Record<string, unknown>;
  source: string;
  occurred_at: string;
  correlation_id: string;
}

// Ações que encerram algo merecem destaque no histórico.
const WARNING_ACTIONS = new Set(['event.cancelled', 'event.deleted', 'ticket.cancelled']);

export function buildActivityMessage(activity: Activity): ActivityMessage {
  return {
    message_id: randomUUID(),
    action: activity.action,
    entity_type: activity.entity_type,
    entity_id: activity.entity_id,
    level: activity.level ?? (WARNING_ACTIONS.has(activity.action) ? 'WARNING' : 'INFO'),
    message: activity.message,
    data: activity.data ?? {},
    source: SERVICE_NAME,
    occurred_at: new Date().toISOString(),
    correlation_id: getCorrelationId(),
  };
}
