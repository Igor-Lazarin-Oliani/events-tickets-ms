/**
 * Registro de atividade de um evento, com o estado das vagas no momento da mudança. action é uma de
 * event.created, event.updated, event.cancelled, event.deleted, event.spot_reserved e
 * event.spot_released.
 */
export function eventActivity(action, event, message, extra = {}) {
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
