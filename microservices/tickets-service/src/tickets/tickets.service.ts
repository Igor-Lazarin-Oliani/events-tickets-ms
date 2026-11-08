import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { randomInt } from 'node:crypto';
import { FindOptionsWhere, QueryFailedError, Not, Repository } from 'typeorm';
import { EventDetails, EventsClientService } from '../events-integration/events-client.service';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent } from '../metrics/telemetry';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { ACTIVE_PARTICIPANT_INDEX, Ticket, TicketStatus } from './entities/ticket.entity';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const TICKET_CODE_PREFIX = 'EVT-2026-';
const TICKET_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TICKET_CODE_SUFFIX_LENGTH = 6;
const MAX_TICKET_CODE_ATTEMPTS = 5;

const ALREADY_REGISTERED = 'Participant already registered for this event';
const CONCURRENT_CHANGE = 'Ticket status changed concurrently';

function uniqueViolationConstraint(error: unknown): string | undefined {
  if (error instanceof QueryFailedError) {
    const driverError = error.driverError as { code?: string; constraint?: string };
    if (driverError.code === POSTGRES_UNIQUE_VIOLATION) {
      return driverError.constraint ?? '';
    }
  }
  return undefined;
}

function generateTicketCode(): string {
  let suffix = '';
  for (let index = 0; index < TICKET_CODE_SUFFIX_LENGTH; index += 1) {
    suffix += TICKET_CODE_ALPHABET[randomInt(TICKET_CODE_ALPHABET.length)];
  }
  return `${TICKET_CODE_PREFIX}${suffix}`;
}

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    private readonly eventsClient: EventsClientService,
    private readonly metrics: MetricsService,
  ) {}

  async create(dto: CreateTicketDto): Promise<Ticket> {
    const event = await this.eventsClient.getEventById(dto.event_id);
    this.assertEventOpen(event);
    await this.assertNotRegistered(dto);

    await this.eventsClient.reserveSpot(dto.event_id);

    try {
      const ticket = await this.saveWithUniqueCode(dto, event);
      this.metrics.incrementTicketsIssued();
      logEvent('TICKET ISSUED', {
        ticket_id: ticket.id,
        ticket_code: ticket.ticket_code,
        event_id: ticket.event_id,
      });
      return ticket;
    } catch (error) {
      await this.compensateReservation(dto.event_id);
      if (uniqueViolationConstraint(error) === ACTIVE_PARTICIPANT_INDEX) {
        throw new ConflictException(ALREADY_REGISTERED);
      }
      logEvent(
        'TICKET ISSUE FAILED',
        { event_id: dto.event_id, reason: error instanceof Error ? error.message : 'unknown' },
        'ERROR',
      );
      throw new InternalServerErrorException('Could not issue ticket');
    }
  }

  findAll(query: ListTicketsQueryDto): Promise<Ticket[]> {
    const where: FindOptionsWhere<Ticket> = {};
    if (query.event_id) where.event_id = query.event_id;
    if (query.participant_email) where.participant_email = query.participant_email;
    if (query.status) where.status = query.status;
    return this.tickets.find({ where, order: { created_at: 'DESC' } });
  }

  async findOne(idOrCode: string): Promise<Ticket> {
    const where = isUUID(idOrCode) ? { id: idOrCode } : { ticket_code: idOrCode };
    const ticket = await this.tickets.findOne({ where });
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
    );
    if (Object.keys(changes).length === 0) {
      return ticket;
    }

    await this.applyUpdate(ticket, changes);
    if (dto.status === TicketStatus.CHECKED_IN) {
      logEvent('TICKET CHECKED IN', { ticket_id: id, event_id: ticket.event_id });
    }
    return this.findOne(id);
  }

  async cancel(id: string): Promise<Ticket> {
    const ticket = await this.findOne(id);
    if (ticket.status === TicketStatus.CANCELLED) {
      throw new ConflictException('Ticket is already cancelled');
    }

    // A condição no status impede que cancelamentos simultâneos devolvam a vaga duas vezes.
    const result = await this.tickets.update(
      { id, status: ticket.status },
      { status: TicketStatus.CANCELLED },
    );
    if (!result.affected) {
      throw new ConflictException(CONCURRENT_CHANGE);
    }

    try {
      await this.eventsClient.releaseSpot(ticket.event_id);
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        await this.restoreStatus(ticket);
        throw error;
      }
      logEvent(
        'TICKET CANCELLED WITHOUT EVENT',
        { ticket_id: id, event_id: ticket.event_id },
        'WARNING',
      );
    }

    this.metrics.incrementTicketsCancelled();
    logEvent('TICKET CANCELLED', { ticket_id: id, event_id: ticket.event_id });
    return this.findOne(id);
  }

  /**
   * Cancela os ingressos ativos de um evento cancelado ou removido. É idempotente, pois a entrega
   * é "ao menos uma vez", e não devolve vagas, já que o evento não aceita mais inscrições.
   */
  async cancelAllForEvent(eventId: string): Promise<number> {
    const result = await this.tickets.update(
      { event_id: eventId, status: Not(TicketStatus.CANCELLED) },
      { status: TicketStatus.CANCELLED },
    );
    const cancelled = result.affected ?? 0;
    if (cancelled > 0) {
      this.metrics.incrementTicketsCancelled(cancelled);
    }
    logEvent('TICKETS CANCELLED BY EVENT', { event_id: eventId, cancelled });
    return cancelled;
  }

  private assertEventOpen(event: EventDetails): void {
    // SOLD_OUT é verificado antes do status geral para o cliente receber 409, não 400.
    if (event.status === 'SOLD_OUT') {
      throw new ConflictException('Event is sold out');
    }
    if (event.status !== 'PUBLISHED') {
      throw new BadRequestException('Event is not open for registrations');
    }
    if (event.available_spots <= 0) {
      throw new ConflictException('Event is sold out');
    }
  }

  private async assertNotRegistered(dto: CreateTicketDto): Promise<void> {
    const existing = await this.tickets.findOne({
      where: {
        event_id: dto.event_id,
        participant_document: dto.participant_document,
        status: Not(TicketStatus.CANCELLED),
      },
    });
    if (existing) {
      throw new ConflictException(ALREADY_REGISTERED);
    }
  }

  private async saveWithUniqueCode(dto: CreateTicketDto, event: EventDetails): Promise<Ticket> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.tickets.save(
          this.tickets.create({
            ticket_code: generateTicketCode(),
            event_id: dto.event_id,
            event_snapshot: {
              title: event.title,
              category: event.category,
              modality: event.modality,
              location: event.location,
              start_at: event.start_at,
            },
            participant_name: dto.participant_name,
            participant_email: dto.participant_email,
            participant_document: dto.participant_document,
            modality_tier: dto.modality_tier ?? 'STANDARD',
            status: TicketStatus.CONFIRMED,
          }),
        );
      } catch (error) {
        const constraint = uniqueViolationConstraint(error);
        const isCodeCollision = constraint !== undefined && constraint !== ACTIVE_PARTICIPANT_INDEX;
        if (!isCodeCollision || attempt === MAX_TICKET_CODE_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  private async applyUpdate(ticket: Ticket, changes: Partial<Ticket>): Promise<void> {
    try {
      const result = await this.tickets.update({ id: ticket.id, status: ticket.status }, changes);
      if (!result.affected) {
        throw new ConflictException(CONCURRENT_CHANGE);
      }
    } catch (error) {
      if (uniqueViolationConstraint(error) === ACTIVE_PARTICIPANT_INDEX) {
        throw new ConflictException(ALREADY_REGISTERED);
      }
      throw error;
    }
  }

  private async compensateReservation(eventId: string): Promise<void> {
    try {
      await this.eventsClient.releaseSpot(eventId);
      logEvent('COMPENSATION APPLIED', { action: 'release-spot', event_id: eventId }, 'WARNING');
    } catch (error) {
      logEvent(
        'COMPENSATION FAILED',
        {
          action: 'release-spot',
          event_id: eventId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'ERROR',
      );
    }
  }

  private async restoreStatus(ticket: Ticket): Promise<void> {
    try {
      await this.tickets.update(
        { id: ticket.id, status: TicketStatus.CANCELLED },
        { status: ticket.status },
      );
      logEvent(
        'COMPENSATION APPLIED',
        { action: 'restore-ticket-status', ticket_id: ticket.id, status: ticket.status },
        'WARNING',
      );
    } catch (error) {
      logEvent(
        'COMPENSATION FAILED',
        {
          action: 'restore-ticket-status',
          ticket_id: ticket.id,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'ERROR',
      );
    }
  }
}
