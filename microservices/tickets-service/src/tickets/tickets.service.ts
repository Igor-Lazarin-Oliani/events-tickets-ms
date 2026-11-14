import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  DEFAULT_LIST_LIMIT,
  Page,
  PaginationQueryDto,
  pageRequest,
} from '../common/pagination';
import { reasonOf, uniqueViolationConstraint } from '../common/postgres-errors';
import {
  EventsClientService,
  EventsServiceUnavailableError,
  ReservedEvent,
} from '../events-integration/events-client.service';
import { HistoryResponseDto } from '../logs-integration/dto/history-response.dto';
import { DEFAULT_HISTORY_LIMIT, LogsClientService } from '../logs-integration/logs-client.service';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent } from '../metrics/telemetry';
import { activityMessage, spotReleaseRequested } from '../outbox/activity';
import { OutboxRepository } from '../outbox/outbox.repository';
import { ClosedEventsRepository } from './closed-events.repository';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { EventClosureReason } from './entities/closed-event.entity';
import { ACTIVE_PARTICIPANT_INDEX, Ticket, TicketStatus } from './entities/ticket.entity';
import { ticketActivity, ticketCancelledByEvent } from './ticket-activities';
import { TicketsRepository } from './tickets.repository';

export const ALREADY_REGISTERED = 'Participant already registered for this event';
export const NOT_OPEN = 'Event is not open for registrations';
const CONCURRENT_CHANGE = 'Ticket status changed concurrently';

/** O evento foi encerrado entre a reserva e o salvamento do ingresso (D32). */
class EventClosedDuringIssueError extends ConflictException {
  constructor() {
    super(NOT_OPEN);
  }
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tickets: TicketsRepository,
    private readonly closedEvents: ClosedEventsRepository,
    private readonly outbox: OutboxRepository,
    private readonly eventsClient: EventsClientService,
    private readonly metrics: MetricsService,
    private readonly logsClient: LogsClientService,
  ) {}

  /**
   * Emissão em dois passos, com o events-service dono das vagas (D30): reserva a vaga por HTTP,
   * com o id do ingresso como chave de idempotência, e salva o ingresso em uma transação local. Se
   * o segundo passo falhar, a reserva é desfeita por uma mensagem de devolução (compensação).
   */
  async create(dto: CreateTicketDto): Promise<Ticket> {
    // Consultas locais antes da reserva: evitam reservar uma vaga que seria devolvida em seguida.
    if (await this.closedEvents.isClosed(dto.event_id)) {
      throw new BadRequestException(NOT_OPEN);
    }
    await this.assertNotRegistered(dto);

    const ticketId = randomUUID();
    const event = await this.reserveSpot(dto.event_id, ticketId);

    let ticket: Ticket;
    try {
      ticket = await this.dataSource.transaction(async (manager) => {
        // Mesmo lock do cancelamento em cascata: ou este ingresso é salvo antes e cancelado junto
        // com os outros, ou o evento já aparece aqui como encerrado.
        await this.closedEvents.lock(manager, dto.event_id);
        if (await this.closedEvents.isClosed(dto.event_id, manager)) {
          throw new EventClosedDuringIssueError();
        }
        const saved = await this.tickets.insertWithUniqueCode(manager, {
          id: ticketId,
          event_id: dto.event_id,
          event_snapshot: {
            title: event.title,
            category: event.category,
            modality: event.modality,
            location: event.location,
            start_at: new Date(event.start_at).toISOString(),
          },
          participant_name: dto.participant_name,
          participant_email: dto.participant_email,
          participant_document: dto.participant_document,
          modality_tier: dto.modality_tier ?? 'STANDARD',
          status: TicketStatus.CONFIRMED,
        });
        await this.outbox.enqueue(manager, [
          activityMessage(ticketActivity('ticket.issued', saved, `Ticket ${saved.ticket_code} issued`)),
        ]);
        return saved;
      });
    } catch (error) {
      await this.compensate(dto.event_id, ticketId, error);
      throw this.translateIssueError(error, dto.event_id);
    }

    this.metrics.incrementTicketsIssued();
    logEvent('TICKET ISSUED', {
      ticket_id: ticket.id,
      ticket_code: ticket.ticket_code,
      event_id: ticket.event_id,
    });
    return ticket;
  }

  findAll(query: ListTicketsQueryDto): Promise<Page<Ticket>> {
    const { event_id, participant_email, status } = query;
    return this.tickets.findAll(
      { event_id, participant_email, status },
      pageRequest(query, DEFAULT_LIST_LIMIT),
    );
  }

  async findOne(idOrCode: string): Promise<Ticket> {
    const ticket = await this.tickets.findByIdOrCode(idOrCode);
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    return ticket;
  }

  async update(id: string, dto: UpdateTicketDto): Promise<Ticket> {
    const ticket = await this.findOne(id);
    if (ticket.status === TicketStatus.CANCELLED) {
      throw new ConflictException('Cancelled ticket cannot be modified');
    }
    if (dto.status === TicketStatus.CHECKED_IN && ticket.status !== TicketStatus.CONFIRMED) {
      throw new ConflictException('Ticket is already checked in');
    }

    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as Partial<Ticket>;
    const changedFields = Object.keys(changes);
    if (changedFields.length === 0) {
      return ticket;
    }

    const checkIn = dto.status === TicketStatus.CHECKED_IN;
    try {
      await this.dataSource.transaction(async (manager) => {
        const updated = await this.tickets.updateIfStatus(manager, ticket.id, ticket.status, changes);
        if (!updated) {
          throw new ConflictException(CONCURRENT_CHANGE);
        }
        const current = { ...ticket, ...changes };
        await this.outbox.enqueue(manager, [
          activityMessage(
            checkIn
              ? ticketActivity('ticket.checked_in', current, `Ticket ${ticket.ticket_code} checked in`)
              : ticketActivity('ticket.updated', current, `Ticket ${ticket.ticket_code} updated`, {
                  changed_fields: changedFields,
                }),
          ),
        ]);
      });
    } catch (error) {
      if (uniqueViolationConstraint(error) === ACTIVE_PARTICIPANT_INDEX) {
        throw new ConflictException(ALREADY_REGISTERED);
      }
      throw error;
    }

    logEvent(checkIn ? 'TICKET CHECKED IN' : 'TICKET UPDATED', {
      ticket_id: ticket.id,
      event_id: ticket.event_id,
      changed_fields: changedFields,
    });
    return this.findOne(ticket.id);
  }

  /**
   * Cancela o ingresso e, na mesma transação, grava o pedido de devolução da vaga ao events-service
   * (D31). A resposta não espera a devolução, e o pedido não se perde se o events-service cair.
   */
  async cancel(id: string): Promise<Ticket> {
    const ticket = await this.findOne(id);
    if (ticket.status === TicketStatus.CANCELLED) {
      throw new ConflictException('Ticket is already cancelled');
    }

    await this.dataSource.transaction(async (manager) => {
      // A condição no status impede que cancelamentos simultâneos peçam a devolução duas vezes.
      const cancelled = await this.tickets.updateIfStatus(manager, ticket.id, ticket.status, {
        status: TicketStatus.CANCELLED,
      });
      if (!cancelled) {
        throw new ConflictException(CONCURRENT_CHANGE);
      }
      await this.outbox.enqueue(manager, [
        activityMessage(
          ticketActivity(
            'ticket.cancelled',
            { ...ticket, status: TicketStatus.CANCELLED },
            `Ticket ${ticket.ticket_code} cancelled`,
            { previous_status: ticket.status, reason: 'requested' },
          ),
        ),
        spotReleaseRequested(ticket.event_id, ticket.id, 'ticket_cancelled'),
      ]);
    });

    this.metrics.incrementTicketsCancelled();
    logEvent('TICKET CANCELLED', {
      ticket_id: ticket.id,
      event_id: ticket.event_id,
      spot_release: 'queued',
    });
    return this.findOne(ticket.id);
  }

  /**
   * Cancela os ingressos ativos de um evento cancelado ou removido, avisado pelo events-service
   * pelo RabbitMQ (D33). É idempotente, porque a entrega é "ao menos uma vez", e não devolve vagas,
   * já que o evento não aceita mais inscrições.
   */
  async cancelAllForEvent(eventId: string, reason: EventClosureReason): Promise<number> {
    const cancelled = await this.dataSource.transaction(async (manager) => {
      await this.closedEvents.lock(manager, eventId);
      await this.closedEvents.markClosed(manager, eventId, reason);
      const refs = await this.tickets.cancelActiveForEvent(manager, eventId);
      await this.outbox.enqueue(
        manager,
        refs.map((ref) => activityMessage(ticketCancelledByEvent(ref, eventId, reason))),
      );
      return refs;
    });

    if (cancelled.length > 0) {
      this.metrics.incrementTicketsCancelled(cancelled.length);
    }
    logEvent('TICKETS CANCELLED BY EVENT', {
      event_id: eventId,
      reason,
      tickets_cancelled: cancelled.length,
    });
    return cancelled.length;
  }

  async getHistory(idOrCode: string, query: PaginationQueryDto = {}): Promise<HistoryResponseDto> {
    const ticket = await this.findOne(idOrCode);
    return this.logsClient.getHistory(
      'ticket',
      ticket.id,
      pageRequest(query, DEFAULT_HISTORY_LIMIT),
    );
  }

  private async assertNotRegistered(dto: CreateTicketDto): Promise<void> {
    const existing = await this.tickets.findActiveRegistration(
      dto.event_id,
      dto.participant_document,
    );
    if (existing) {
      throw new ConflictException(ALREADY_REGISTERED);
    }
  }

  /** Reserva no events-service; sem resposta definitiva, pede a devolução antes de responder 503. */
  private async reserveSpot(eventId: string, ticketId: string): Promise<ReservedEvent> {
    try {
      const event = await this.eventsClient.reserveSpot(eventId, ticketId);
      this.metrics.recordSpotReservation('reserved');
      logEvent('EVENT SPOT RESERVED', {
        event_id: eventId,
        ticket_id: ticketId,
        available_spots: event.available_spots,
        status: event.status,
      });
      return event;
    } catch (error) {
      if (error instanceof EventsServiceUnavailableError) {
        this.metrics.recordSpotReservation('unavailable');
        // Um timeout não diz se a vaga foi reservada; a devolução é idempotente e resolve os dois casos.
        await this.compensate(eventId, ticketId, error);
      } else {
        this.metrics.recordSpotReservation('rejected');
      }
      throw error;
    }
  }

  /**
   * Compensação: grava na outbox o pedido de devolução da vaga reservada para este ingresso. Se
   * nem isso for possível (tickets-db fora do ar), a vaga fica presa, e o log registra o ticket_id
   * que permite identificá-la no events-db.
   */
  private async compensate(eventId: string, ticketId: string, cause: unknown): Promise<void> {
    try {
      await this.outbox.enqueue(this.dataSource.manager, [
        spotReleaseRequested(eventId, ticketId, 'issue_failed'),
      ]);
      this.metrics.recordCompensation('queued');
      logEvent(
        'COMPENSATION QUEUED',
        {
          action: 'spot.release_requested',
          event_id: eventId,
          ticket_id: ticketId,
          cause: reasonOf(cause),
        },
        'WARNING',
      );
    } catch (error) {
      this.metrics.recordCompensation('failed');
      logEvent(
        'COMPENSATION FAILED',
        {
          action: 'spot.release_requested',
          event_id: eventId,
          ticket_id: ticketId,
          reason: reasonOf(error),
        },
        'ERROR',
      );
    }
  }

  private translateIssueError(error: unknown, eventId: string): HttpException {
    if (error instanceof HttpException) {
      return error;
    }
    // Inscrição simultânea com o mesmo documento: o índice único barra, e a vaga é devolvida.
    if (uniqueViolationConstraint(error) === ACTIVE_PARTICIPANT_INDEX) {
      return new ConflictException(ALREADY_REGISTERED);
    }
    logEvent('TICKET ISSUE FAILED', { event_id: eventId, reason: reasonOf(error) }, 'ERROR');
    return new InternalServerErrorException('Could not issue ticket');
  }
}
