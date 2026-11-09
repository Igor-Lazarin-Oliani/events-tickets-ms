import { Activity } from '../outbox/activity';
import { Ticket, TicketStatus } from './entities/ticket.entity';
import { CancelledTicketRef } from './tickets.repository';

export type TicketAction = 'ticket.issued' | 'ticket.updated' | 'ticket.checked_in' | 'ticket.cancelled';
export type CancellationReason = 'requested' | 'event_cancelled' | 'event_deleted';

/**
 * Registro de atividade de um ingresso. Nome, e-mail e documento do participante ficam de fora:
 * os logs são exibidos ao vivo, e o histórico não precisa deles.
 */
export function ticketActivity(
  action: TicketAction,
  ticket: Pick<Ticket, 'id' | 'ticket_code' | 'event_id' | 'status' | 'modality_tier'>,
  message: string,
  extra: Record<string, unknown> = {},
): Activity {
  return {
    action,
    entity_type: 'ticket',
    entity_id: ticket.id,
    message,
    data: {
      ticket_code: ticket.ticket_code,
      event_id: ticket.event_id,
      status: ticket.status,
      modality_tier: ticket.modality_tier,
      ...extra,
    },
  };
}

/** Ingresso cancelado em lote porque o evento foi cancelado ou removido. */
export function ticketCancelledByEvent(
  ticket: CancelledTicketRef,
  eventId: string,
  reason: Exclude<CancellationReason, 'requested'>,
): Activity {
  const cause = reason === 'event_cancelled' ? 'cancelled' : 'deleted';
  return {
    action: 'ticket.cancelled',
    entity_type: 'ticket',
    entity_id: ticket.id,
    message: `Ticket ${ticket.ticket_code} cancelled because the event was ${cause}`,
    data: {
      ticket_code: ticket.ticket_code,
      event_id: eventId,
      status: TicketStatus.CANCELLED,
      reason,
    },
  };
}
