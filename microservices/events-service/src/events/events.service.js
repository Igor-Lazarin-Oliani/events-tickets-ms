import {
  BadRequestException,
  ConflictException,
  Dependencies,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DEFAULT_LIST_LIMIT, pageRequest } from '../common/pagination';
import { uniqueViolationConstraint } from '../common/postgres-errors';
import { LogsClientService, DEFAULT_HISTORY_LIMIT } from '../logs-integration/logs-client.service';
import { MetricsService } from '../metrics/metrics.service';
import { logEvent } from '../metrics/telemetry';
import { activityMessage, eventClosed } from '../outbox/activity';
import { OutboxRepository } from '../outbox/outbox.repository';
import { EVENT_NOT_FOUND, EventStatus } from './entities/event.entity';
import { ReservationStatus } from './entities/spot-reservation.entity';
import { eventActivity } from './event-activities';
import { EventsRepository } from './events.repository';
import { ReservationsRepository } from './reservations.repository';

export const SOLD_OUT = 'Event is sold out';
export const NOT_OPEN = 'Event is not open for registrations';
export const ENDED = 'Event has already ended';
export const RESERVATION_RELEASED = 'Reservation for this ticket was already released';
export const RESERVATION_OF_OTHER_EVENT = 'Reservation for this ticket belongs to another event';

function assertPeriod(startAt, endAt) {
  if (endAt.getTime() <= startAt.getTime()) {
    throw new BadRequestException('end_at must be after start_at');
  }
}

/** Evento cujo fim já passou não aceita inscrições; o UPDATE da reserva repete a regra no banco. */
function hasEnded(event) {
  return new Date(event.end_at).getTime() <= Date.now();
}

/** 409 de uma reserva que passou na consulta, mas perdeu a corrida no UPDATE condicional. */
export class ReservationRaceError extends ConflictException {}

function definedFields(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  );
}

@Injectable()
@Dependencies(
  DataSource,
  EventsRepository,
  ReservationsRepository,
  OutboxRepository,
  MetricsService,
  LogsClientService,
)
export class EventsService {
  constructor(dataSource, events, reservations, outbox, metrics, logsClient) {
    this.dataSource = dataSource;
    this.events = events;
    this.reservations = reservations;
    this.outbox = outbox;
    this.metrics = metrics;
    this.logsClient = logsClient;
  }

  async create(dto) {
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
        activityMessage(eventActivity('event.created', created, `Event "${created.title}" created`)),
      ]);
      return created;
    });

    logEvent('EVENT CREATED', { event_id: event.id, max_capacity: event.max_capacity });
    return event;
  }

  findAll(query) {
    const { category, status } = query;
    return this.events.findAll({ category, status }, pageRequest(query, DEFAULT_LIST_LIMIT));
  }

  async findOne(id) {
    const event = await this.events.findById(id);
    if (!event) {
      throw new NotFoundException(EVENT_NOT_FOUND);
    }
    return event;
  }

  /**
   * Atualização parcial. Cancelar o evento grava, na mesma transação, o aviso event.cancelled
   * para o tickets-service, que cancela os ingressos ativos ao consumir (D33).
   */
  async update(id, dto) {
    const changedFields = Object.keys(definedFields(dto));

    const { event, becameCancelled } = await this.dataSource.transaction(async (manager) => {
      const current = await this.events.findByIdForUpdate(manager, id);
      if (!current) {
        throw new NotFoundException(EVENT_NOT_FOUND);
      }
      const previousStatus = current.status;
      const saved = await this.events.save(manager, this.applyUpdate(current, dto));
      const becameCancelled =
        saved.status === EventStatus.CANCELLED && previousStatus !== EventStatus.CANCELLED;

      const messages = [];
      if (becameCancelled) {
        messages.push(
          activityMessage(
            eventActivity('event.cancelled', saved, `Event "${saved.title}" cancelled`, {
              changed_fields: changedFields,
            }),
          ),
          eventClosed('event.cancelled', saved.id),
        );
      } else if (changedFields.length > 0) {
        messages.push(
          activityMessage(
            eventActivity('event.updated', saved, `Event "${saved.title}" updated`, {
              changed_fields: changedFields,
            }),
          ),
        );
      }
      await this.outbox.enqueue(manager, messages);
      return { event: saved, becameCancelled };
    });

    logEvent(becameCancelled ? 'EVENT CANCELLED' : 'EVENT UPDATED', {
      event_id: id,
      changed_fields: changedFields,
      ...(becameCancelled && { tickets_cancellation: 'queued' }),
    });
    return event;
  }

  /** Remove o evento e grava o aviso event.deleted para o tickets-service (D33). */
  async remove(id) {
    await this.dataSource.transaction(async (manager) => {
      // O lock espera as reservas em andamento, que já contam no aviso ao tickets-service.
      const event = await this.events.findByIdForUpdate(manager, id);
      if (!event) {
        throw new NotFoundException(EVENT_NOT_FOUND);
      }
      await this.events.delete(manager, id);
      await this.outbox.enqueue(manager, [
        activityMessage(eventActivity('event.deleted', event, `Event "${event.title}" deleted`)),
        eventClosed('event.deleted', id),
      ]);
    });

    logEvent('EVENT DELETED', { event_id: id, tickets_cancellation: 'queued' });
  }

  async getHistory(id, query = {}) {
    await this.findOne(id);
    return this.logsClient.getHistory('event', id, pageRequest(query, DEFAULT_HISTORY_LIMIT));
  }

  /**
   * Reserva uma vaga para o ingresso que o tickets-service vai salvar (D30). O ticket_id é a chave
   * de idempotência: se a reserva já existe, devolve o evento sem reservar outra vaga.
   */
  async reserveSpot(id, ticketId) {
    let outcome;
    try {
      outcome = await this.reserveOnce(id, ticketId);
    } catch (error) {
      if (error instanceof HttpException) {
        // conflict: perdeu a corrida depois da consulta; rejected: o evento já estava fechado.
        this.metrics.recordSpotOperation(
          'reserve',
          error instanceof ReservationRaceError ? 'conflict' : 'rejected',
        );
        logEvent(
          'EVENT SPOT REJECTED',
          { event_id: id, ticket_id: ticketId, status: error.getStatus(), reason: error.message },
          'WARNING',
        );
      }
      throw error;
    }

    const { event, replayed } = outcome;
    this.metrics.recordSpotOperation('reserve', replayed ? 'replayed' : 'success');
    logEvent('EVENT SPOT RESERVED', {
      event_id: event.id,
      ticket_id: ticketId,
      available_spots: event.available_spots,
      status: event.status,
      replayed,
    });
    return event;
  }

  async reserveOnce(id, ticketId) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const existing = await this.reservations.findByTicketId(ticketId, manager);
        if (existing) {
          return this.replayReservation(manager, existing, id);
        }
        // A consulta prévia só melhora a mensagem de erro; quem garante a vaga é o UPDATE condicional.
        const event = await this.events.findById(id, manager);
        if (!event) {
          throw new NotFoundException(EVENT_NOT_FOUND);
        }
        this.assertEventOpen(event);

        const reserved = await this.events.reserveSpot(manager, id);
        if (!reserved) {
          throw await this.reservationRejected(manager, id);
        }
        await this.reservations.insert(manager, {
          ticket_id: ticketId,
          event_id: id,
          status: ReservationStatus.RESERVED,
          reserved_at: new Date(),
        });
        await this.outbox.enqueue(manager, [
          activityMessage(
            eventActivity('event.spot_reserved', reserved, `Spot reserved for ticket ${ticketId}`, {
              ticket_id: ticketId,
            }),
          ),
        ]);
        return { event: reserved, replayed: false };
      });
    } catch (error) {
      // Reserva repetida em paralelo, ou devolução que chegou antes: a chave primária barra a
      // segunda linha, o rollback desfaz o decremento, e vale a reserva que já estava gravada.
      if (uniqueViolationConstraint(error) === undefined) {
        throw error;
      }
      return this.dataSource.transaction(async (manager) =>
        this.replayReservation(
          manager,
          await this.reservations.findByTicketId(ticketId, manager),
          id,
        ),
      );
    }
  }

  /**
   * Devolve a vaga reservada para o ingresso, pedida pelo tickets-service pelo RabbitMQ (D31).
   * Aplica uma única vez: repetição, ou devolução de reserva que não existe, não muda as vagas.
   */
  async releaseReservation(ticketId, eventId, reason) {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const reservation = await this.reservations.findByTicketIdForUpdate(manager, ticketId);
      if (!reservation) {
        // A reserva pode ainda estar a caminho: a linha RELEASED faz o events-service recusá-la.
        await this.reservations.insert(manager, {
          ticket_id: ticketId,
          event_id: eventId,
          status: ReservationStatus.RELEASED,
          released_at: new Date(),
        });
        return { result: 'not_reserved' };
      }
      if (reservation.status === ReservationStatus.RELEASED) {
        return { result: 'duplicate' };
      }
      await this.reservations.markReleased(manager, ticketId);
      const event = await this.events.releaseSpot(manager, reservation.event_id);
      if (event) {
        await this.outbox.enqueue(manager, [
          activityMessage(
            eventActivity('event.spot_released', event, `Spot released by ticket ${ticketId}`, {
              ticket_id: ticketId,
              reason,
            }),
          ),
        ]);
        return { result: 'success', event };
      }
      const exists = await this.events.findById(reservation.event_id, manager);
      return { result: exists ? 'at_capacity' : 'event_missing' };
    });

    this.metrics.recordSpotOperation('release', outcome.result);
    if (outcome.result === 'success') {
      logEvent('EVENT SPOT RELEASED', {
        event_id: outcome.event.id,
        ticket_id: ticketId,
        available_spots: outcome.event.available_spots,
        status: outcome.event.status,
        reason,
      });
    } else {
      logEvent(
        'EVENT SPOT RELEASE IGNORED',
        { event_id: eventId, ticket_id: ticketId, result: outcome.result, reason },
        outcome.result === 'duplicate' ? 'INFO' : 'WARNING',
      );
    }
    return outcome.result;
  }

  /** Reserva já gravada para o ticket_id: devolve o evento, ou recusa se ela não vale mais. */
  async replayReservation(manager, reservation, id) {
    if (reservation.event_id !== id) {
      throw new ConflictException(RESERVATION_OF_OTHER_EVENT);
    }
    if (reservation.status === ReservationStatus.RELEASED) {
      throw new ConflictException(RESERVATION_RELEASED);
    }
    const event = await this.events.findById(id, manager);
    if (!event) {
      throw new NotFoundException(EVENT_NOT_FOUND);
    }
    return { event, replayed: true };
  }

  assertEventOpen(event) {
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

  /** Explica por que o UPDATE condicional não reservou: o evento mudou depois da consulta. */
  async reservationRejected(manager, id) {
    const current = await this.events.findById(id, manager);
    if (!current) {
      return new NotFoundException(EVENT_NOT_FOUND);
    }
    // Perdeu a corrida para outra reserva, para o cancelamento ou para o fim do evento.
    if (hasEnded(current)) {
      return new ReservationRaceError(ENDED);
    }
    return new ReservationRaceError(current.available_spots <= 0 ? SOLD_OUT : NOT_OPEN);
  }

  /** Aplica a atualização parcial com as regras de período, capacidade (D2) e status (D17). */
  applyUpdate(event, dto) {
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
}
