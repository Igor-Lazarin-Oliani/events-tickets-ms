import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  DEFAULT_LIST_LIMIT,
  Page,
  PaginationQueryDto,
  pageRequest,
} from '../common/pagination';
import { HistoryResponseDto } from '../logs-integration/dto/history-response.dto';
import { DEFAULT_HISTORY_LIMIT, LogsClientService } from '../logs-integration/logs-client.service';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent } from '../metrics/telemetry';
import { Activity } from '../outbox/activity';
import { OutboxRepository } from '../outbox/outbox.repository';
import { ticketCancelledByEvent } from '../tickets/ticket-activities';
import { CancelledTicketRef, TicketsRepository } from '../tickets/tickets.repository';
import { CreateEventDto } from './dto/create-event.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { Event, EVENT_NOT_FOUND, EventStatus } from './entities/event.entity';
import { eventActivity } from './event-activities';
import { EventsRepository } from './events.repository';

function assertPeriod(startAt: Date, endAt: Date): void {
  if (endAt.getTime() <= startAt.getTime()) {
    throw new BadRequestException('end_at must be after start_at');
  }
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as Partial<T>;
}

@Injectable()
export class EventsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventsRepository,
    private readonly tickets: TicketsRepository,
    private readonly outbox: OutboxRepository,
    private readonly metrics: MetricsService,
    private readonly logsClient: LogsClientService,
  ) {}

  async create(dto: CreateEventDto): Promise<Event> {
    const startAt = new Date(dto.start_at);
    const endAt = new Date(dto.end_at);
    assertPeriod(startAt, endAt);

    const event = await this.dataSource.transaction(async (manager) => {
      const created = await this.events.create(manager, {
        title: dto.title,
        description: dto.description ?? null,
        category: dto.category ?? 'GENERAL',
        modality: dto.modality,
        location: dto.location,
        start_at: startAt,
        end_at: endAt,
        max_capacity: dto.max_capacity,
        available_spots: dto.max_capacity,
        status: EventStatus.PUBLISHED,
        metadata_info: dto.metadata_info ?? null,
      });
      await this.outbox.enqueue(manager, [
        eventActivity('event.created', created, `Event "${created.title}" created`),
      ]);
      return created;
    });

    logEvent('EVENT CREATED', { event_id: event.id, max_capacity: event.max_capacity });
    return event;
  }

  findAll(query: ListEventsQueryDto): Promise<Page<Event>> {
    const { category, status } = query;
    return this.events.findAll({ category, status }, pageRequest(query, DEFAULT_LIST_LIMIT));
  }

  async findOne(id: string): Promise<Event> {
    const event = await this.events.findById(id);
    if (!event) {
      throw new NotFoundException(EVENT_NOT_FOUND);
    }
    return event;
  }

  async update(id: string, dto: UpdateEventDto): Promise<Event> {
    const changedFields = Object.keys(definedFields(dto));

    const { event, becameCancelled, cancelledTickets } = await this.dataSource.transaction(
      async (manager) => {
        const current = await this.events.findByIdForUpdate(manager, id);
        if (!current) {
          throw new NotFoundException(EVENT_NOT_FOUND);
        }
        const previousStatus = current.status;
        const saved = await this.events.save(manager, this.applyUpdate(current, dto));

        const cancelled = saved.status === EventStatus.CANCELLED;
        const becameCancelled = cancelled && previousStatus !== EventStatus.CANCELLED;
        // Mesma transação: um ingresso emitido em paralelo espera o lock e é cancelado junto.
        const cancelledTickets = becameCancelled
          ? await this.tickets.cancelActiveForEvent(manager, id)
          : [];

        const activities: Activity[] = [];
        if (becameCancelled) {
          activities.push(
            eventActivity('event.cancelled', saved, `Event "${saved.title}" cancelled`, {
              changed_fields: changedFields,
              tickets_cancelled: cancelledTickets.length,
            }),
            ...cancelledTickets.map((ticket) => ticketCancelledByEvent(ticket, id, 'event_cancelled')),
          );
        } else if (changedFields.length > 0) {
          activities.push(
            eventActivity('event.updated', saved, `Event "${saved.title}" updated`, {
              changed_fields: changedFields,
            }),
          );
        }
        await this.outbox.enqueue(manager, activities);
        return { event: saved, becameCancelled, cancelledTickets };
      },
    );

    this.recordTicketsCancelledByEvent(cancelledTickets);
    logEvent(becameCancelled ? 'EVENT CANCELLED' : 'EVENT UPDATED', {
      event_id: id,
      changed_fields: changedFields,
      ...(becameCancelled && { tickets_cancelled: cancelledTickets.length }),
    });
    return event;
  }

  async remove(id: string): Promise<void> {
    const cancelledTickets = await this.dataSource.transaction(async (manager) => {
      // O lock vem antes de cancelar os ingressos, para nenhuma emissão escapar entre os dois.
      const event = await this.events.findByIdForUpdate(manager, id);
      if (!event) {
        throw new NotFoundException(EVENT_NOT_FOUND);
      }
      const cancelled = await this.tickets.cancelActiveForEvent(manager, id);
      await this.events.delete(manager, id);
      await this.outbox.enqueue(manager, [
        eventActivity('event.deleted', event, `Event "${event.title}" deleted`, {
          tickets_cancelled: cancelled.length,
        }),
        ...cancelled.map((ticket) => ticketCancelledByEvent(ticket, id, 'event_deleted')),
      ]);
      return cancelled;
    });

    this.recordTicketsCancelledByEvent(cancelledTickets);
    logEvent('EVENT DELETED', { event_id: id, tickets_cancelled: cancelledTickets.length });
  }

  async getHistory(id: string, query: PaginationQueryDto = {}): Promise<HistoryResponseDto> {
    await this.findOne(id);
    return this.logsClient.getHistory('event', id, pageRequest(query, DEFAULT_HISTORY_LIMIT));
  }

  /** Aplica a atualização parcial com as regras de período, capacidade (D2) e status (D17). */
  private applyUpdate(event: Event, dto: UpdateEventDto): Event {
    const { start_at, end_at, max_capacity, status, ...otherFields } = dto;

    const startAt = start_at !== undefined ? new Date(start_at) : event.start_at;
    const endAt = end_at !== undefined ? new Date(end_at) : event.end_at;
    assertPeriod(startAt, endAt);

    const newCapacity = max_capacity ?? event.max_capacity;
    const occupiedSpots = event.max_capacity - event.available_spots;
    if (newCapacity < occupiedSpots) {
      throw new ConflictException(
        `max_capacity cannot be lower than the ${occupiedSpots} occupied spots`,
      );
    }
    const availableSpots = newCapacity - occupiedSpots;

    let newStatus = status ?? event.status;
    // Terminal: reabrir deixaria vagas presas nos ingressos já cancelados com o evento.
    if (event.status === EventStatus.CANCELLED && newStatus !== EventStatus.CANCELLED) {
      throw new ConflictException('Cancelled event cannot be reopened');
    }
    if (newStatus === EventStatus.PUBLISHED && availableSpots === 0) {
      newStatus = EventStatus.SOLD_OUT;
    } else if (newStatus === EventStatus.SOLD_OUT && availableSpots > 0) {
      newStatus = EventStatus.PUBLISHED;
    }

    return Object.assign(event, definedFields(otherFields), {
      start_at: startAt,
      end_at: endAt,
      max_capacity: newCapacity,
      available_spots: availableSpots,
      status: newStatus,
    });
  }

  private recordTicketsCancelledByEvent(tickets: CancelledTicketRef[]): void {
    if (tickets.length > 0) {
      this.metrics.incrementTicketsCancelled(tickets.length);
    }
  }
}
