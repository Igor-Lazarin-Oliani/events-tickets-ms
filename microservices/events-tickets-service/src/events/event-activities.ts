import { Activity } from '../outbox/activity';
import { Event } from './entities/event.entity';

export type EventAction =
  | 'event.created'
  | 'event.updated'
  | 'event.cancelled'
  | 'event.deleted'
  | 'event.spot_reserved'
  | 'event.spot_released';

/** Registro de atividade de um evento, com o estado das vagas no momento da mudança. */
export function eventActivity(
  action: EventAction,
  event: Event,
  message: string,
  extra: Record<string, unknown> = {},
): Activity {
  return {
    action,
    entity_type: 'event',
    entity_id: event.id,
    message,
    data: {
      title: event.title,
      status: event.status,
      available_spots: event.available_spots,
      max_capacity: event.max_capacity,
      ...extra,
    },
  };
}
