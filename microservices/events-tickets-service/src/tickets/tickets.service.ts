import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  DEFAULT_LIST_LIMIT,
  Page,
  PaginationQueryDto,
  pageRequest,
} from '../common/pagination';
import { reasonOf, uniqueViolationConstraint } from '../common/postgres-errors';
import { Event, EVENT_NOT_FOUND, EventStatus } from '../events/entities/event.entity';
import { eventActivity } from '../events/event-activities';
import { EventsRepository } from '../events/events.repository';
import { HistoryResponseDto } from '../logs-integration/dto/history-response.dto';
import { DEFAULT_HISTORY_LIMIT, LogsClientService } from '../logs-integration/logs-client.service';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent } from '../metrics/telemetry';
import { Activity } from '../outbox/activity';
import { OutboxRepository } from '../outbox/outbox.repository';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { ACTIVE_PARTICIPANT_INDEX, Ticket, TicketStatus } from './entities/ticket.entity';
import { ticketActivity } from './ticket-activities';
import { TicketsRepository } from './tickets.repository';

const ALREADY_REGISTERED = 'Participant already registered for this event';
const CONCURRENT_CHANGE = 'Ticket status changed concurrently';
const SOLD_OUT = 'Event is sold out';
const NOT_OPEN = 'Event is not open for registrations';
const ENDED = 'Event has already ended';

/** Evento cujo fim já passou não aceita inscrições; o UPDATE da reserva repete a regra no banco. */
function hasEnded(event: Event): boolean {
  return event.end_at.getTime() <= Date.now();
}

/** Resultado da devolução de vaga no cancelamento, para métricas e logs depois do commit. */
type SpotRelease =
  | { result: 'success'; event: Event }
  | { result: 'at_capacity' | 'event_missing' };

@Injectable()
export class TicketsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tickets: TicketsRepository,
    private readonly events: EventsRepository,
    private readonly outbox: OutboxRepository,
    private readonly metrics: MetricsService,
    private readonly logsClient: LogsClientService,
  ) {}

  /**
   * Reserva a vaga, salva o ingresso e grava os registros de atividade em uma única transação.
   * Qualquer falha desfaz tudo, inclusive a vaga: não há compensação a fazer.
   */
  async create(dto: CreateTicketDto): Promise<Ticket> {
    // A consulta prévia só melhora a mensagem de erro; quem garante a vaga é o UPDATE condicional.
    const event = await this.events.findById(dto.event_id);
    if (!event) {
      throw new NotFoundException(EVENT_NOT_FOUND);
    }
    this.assertEventOpen(event);
    await this.assertNotRegistered(dto);

    let issued: { ticket: Ticket; event: Event };
    try {
      issued = await this.dataSource.transaction(async (manager) => {
        const reserved = await this.events.reserveSpot(manager, dto.event_id);
        if (!reserved) {
          throw await this.reservationRejected(manager, dto.event_id);
        }
        const ticket = await this.tickets.insertWithUniqueCode(manager, {
          event_id: reserved.id,
          event_snapshot: {
            title: reserved.title,
            category: reserved.category,
            modality: reserved.modality,
            location: reserved.location,
            start_at: reserved.start_at.toISOString(),
          },
          participant_name: dto.participant_name,
          participant_email: dto.participant_email,
          participant_document: dto.participant_document,
          modality_tier: dto.modality_tier ?? 'STANDARD',
          status: TicketStatus.CONFIRMED,
        });
        await this.outbox.enqueue(manager, [
          ticketActivity('ticket.issued', ticket, `Ticket ${ticket.ticket_code} issued`),
          eventActivity('event.spot_reserved', reserved, `Spot reserved for ${ticket.ticket_code}`, {
            ticket_id: ticket.id,
          }),
        ]);
        return { ticket, event: reserved };
      });
    } catch (error) {
      throw this.translateIssueError(error, dto.event_id);
    }

    const { ticket, event: reserved } = issued;
    this.metrics.recordSpotOperation('reserve', 'success');
    this.metrics.incrementTicketsIssued();
    logEvent('EVENT SPOT RESERVED', {
      event_id: reserved.id,
      available_spots: reserved.available_spots,
      status: reserved.status,
    });
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
          checkIn
            ? ticketActivity('ticket.checked_in', current, `Ticket ${ticket.ticket_code} checked in`)
            : ticketActivity('ticket.updated', current, `Ticket ${ticket.ticket_code} updated`, {
                changed_fields: changedFields,
              }),
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

  /** Cancela o ingresso e devolve a vaga na mesma transação. */
  async cancel(id: string): Promise<Ticket> {
    const ticket = await this.findOne(id);
    if (ticket.status === TicketStatus.CANCELLED) {
      throw new ConflictException('Ticket is already cancelled');
    }

    const release = await this.dataSource.transaction(async (manager) => {
      // A condição no status impede que cancelamentos simultâneos devolvam a vaga duas vezes.
      const cancelled = await this.tickets.updateIfStatus(manager, ticket.id, ticket.status, {
        status: TicketStatus.CANCELLED,
      });
      if (!cancelled) {
        throw new ConflictException(CONCURRENT_CHANGE);
      }
      const spot = await this.releaseSpot(manager, ticket.event_id);

      const activities: Activity[] = [
        ticketActivity(
          'ticket.cancelled',
          { ...ticket, status: TicketStatus.CANCELLED },
          `Ticket ${ticket.ticket_code} cancelled`,
          { previous_status: ticket.status, reason: 'requested' },
        ),
      ];
      if (spot.result === 'success') {
        activities.push(
          eventActivity(
            'event.spot_released',
            spot.event,
            `Spot released by ${ticket.ticket_code}`,
            { ticket_id: ticket.id },
          ),
        );
      }
      await this.outbox.enqueue(manager, activities);
      return spot;
    });

    this.logSpotRelease(ticket, release);
    this.metrics.incrementTicketsCancelled();
    logEvent('TICKET CANCELLED', { ticket_id: ticket.id, event_id: ticket.event_id });
    return this.findOne(ticket.id);
  }

  async getHistory(idOrCode: string, query: PaginationQueryDto = {}): Promise<HistoryResponseDto> {
    const ticket = await this.findOne(idOrCode);
    return this.logsClient.getHistory(
      'ticket',
      ticket.id,
      pageRequest(query, DEFAULT_HISTORY_LIMIT),
    );
  }

  private assertEventOpen(event: Event): void {
    // Encerrado vem primeiro: não importa se ainda há vaga ou qual é o status (D25).
    if (hasEnded(event)) {
      throw new BadRequestException(ENDED);
    }
    // SOLD_OUT é verificado antes do status geral para o cliente receber 409, não 400 (D11).
    if (event.status === EventStatus.SOLD_OUT) {
      throw new ConflictException(SOLD_OUT);
    }
    if (event.status !== EventStatus.PUBLISHED) {
      throw new BadRequestException(NOT_OPEN);
    }
    if (event.available_spots <= 0) {
      throw new ConflictException(SOLD_OUT);
    }
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

  /** Explica por que o UPDATE condicional não reservou: o evento mudou depois da consulta. */
  private async reservationRejected(manager: EntityManager, eventId: string): Promise<HttpException> {
    const current = await this.events.findById(eventId, manager);
    if (!current) {
      return new NotFoundException(EVENT_NOT_FOUND);
    }
    this.metrics.recordSpotOperation('reserve', 'conflict');
    const ended = hasEnded(current);
    logEvent(
      'EVENT SPOT REJECTED',
      {
        event_id: eventId,
        available_spots: current.available_spots,
        status: current.status,
        ended,
      },
      'WARNING',
    );
    if (ended) {
      return new ConflictException(ENDED);
    }
    return new ConflictException(current.available_spots <= 0 ? SOLD_OUT : NOT_OPEN);
  }

  private translateIssueError(error: unknown, eventId: string): HttpException {
    if (error instanceof HttpException) {
      return error;
    }
    // Inscrição simultânea com o mesmo documento: o índice único barra, e o rollback devolve a vaga.
    if (uniqueViolationConstraint(error) === ACTIVE_PARTICIPANT_INDEX) {
      return new ConflictException(ALREADY_REGISTERED);
    }
    logEvent('TICKET ISSUE FAILED', { event_id: eventId, reason: reasonOf(error) }, 'ERROR');
    return new InternalServerErrorException('Could not issue ticket');
  }

  private async releaseSpot(manager: EntityManager, eventId: string): Promise<SpotRelease> {
    const event = await this.events.releaseSpot(manager, eventId);
    if (event) {
      return { result: 'success', event };
    }
    const exists = await this.events.findById(eventId, manager);
    return { result: exists ? 'at_capacity' : 'event_missing' };
  }

  private logSpotRelease(ticket: Ticket, release: SpotRelease): void {
    this.metrics.recordSpotOperation('release', release.result);
    if (release.result === 'success') {
      logEvent('EVENT SPOT RELEASED', {
        event_id: release.event.id,
        available_spots: release.event.available_spots,
        status: release.event.status,
      });
    } else if (release.result === 'at_capacity') {
      logEvent(
        'EVENT SPOT RELEASE IGNORED',
        { event_id: ticket.event_id, reason: 'event already at max_capacity' },
        'WARNING',
      );
    } else {
      // Só acontece com ingresso anterior à remoção em cascata; o cancelamento segue valendo.
      logEvent(
        'TICKET CANCELLED WITHOUT EVENT',
        { ticket_id: ticket.id, event_id: ticket.event_id },
        'WARNING',
      );
    }
  }
}
