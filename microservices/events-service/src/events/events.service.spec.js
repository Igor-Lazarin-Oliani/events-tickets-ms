import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  buildEvent,
  enqueuedActivities,
  enqueuedEventNotices,
  enqueuedMessages,
  EVENT_ID,
  fakeDataSource,
  fakeLogsClient,
  fakeOutbox,
  FUTURE_YEAR,
  metricsWithSpies,
  TICKET_ID,
  uniqueViolation,
} from '../testing/fakes';
import { EventModality, EventStatus } from './entities/event.entity';
import { ReservationStatus } from './entities/spot-reservation.entity';
import { EventsService, ReservationRaceError } from './events.service';

const createDto = {
  title: 'Workshop Docker',
  modality: EventModality.ONLINE,
  location: 'https://example.com/live',
  start_at: '2026-11-20T08:00:00-04:00',
  end_at: '2026-11-20T18:00:00-04:00',
  max_capacity: 5,
};

function reservation(overrides = {}) {
  return {
    ticket_id: TICKET_ID,
    event_id: EVENT_ID,
    status: ReservationStatus.RESERVED,
    ...overrides,
  };
}

function setup(current = buildEvent()) {
  const { dataSource, manager } = fakeDataSource();
  const events = {
    create: jest.fn(async (_manager, data) => buildEvent(data)),
    findAll: jest.fn(),
    findById: jest.fn(async () => current),
    findByIdForUpdate: jest.fn(async () => current),
    save: jest.fn(async (_manager, event) => event),
    delete: jest.fn(async () => true),
    reserveSpot: jest.fn(async () => buildEvent({ available_spots: current.available_spots - 1 })),
    releaseSpot: jest.fn(async () => buildEvent({ available_spots: current.available_spots + 1 })),
  };
  const reservations = {
    findByTicketId: jest.fn(async () => null),
    findByTicketIdForUpdate: jest.fn(async () => reservation()),
    insert: jest.fn(async () => undefined),
    markReleased: jest.fn(async () => undefined),
  };
  const outbox = fakeOutbox();
  const logsClient = fakeLogsClient();
  const { metrics, spots } = metricsWithSpies();
  const service = new EventsService(dataSource, events, reservations, outbox, metrics, logsClient);
  return { service, dataSource, manager, events, reservations, outbox, logsClient, spots };
}

describe('EventsService.create', () => {
  it('começa com todas as vagas livres, status PUBLISHED e categoria GENERAL', async () => {
    const { service, events } = setup();

    await service.create(createDto);

    expect(events.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        available_spots: 5,
        status: EventStatus.PUBLISHED,
        category: 'GENERAL',
        start_at: new Date('2026-11-20T12:00:00Z'),
      }),
    );
  });

  it('registra event.created na mesma transação, com origem events-service', async () => {
    const { service, outbox } = setup();

    await service.create(createDto);

    expect(enqueuedActivities(outbox)).toEqual([
      expect.objectContaining({
        action: 'event.created',
        entity_type: 'event',
        source: 'events-service',
      }),
    ]);
    expect(enqueuedEventNotices(outbox)).toEqual([]);
  });

  it('responde 400 quando o fim não é posterior ao início', async () => {
    const { service, dataSource } = setup();

    await expect(service.create({ ...createDto, end_at: createDto.start_at })).rejects.toThrow(
      new BadRequestException('end_at must be after start_at'),
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});

describe('EventsService.findAll', () => {
  it('aplica a página padrão e repassa só os filtros', async () => {
    const { service, events } = setup();
    events.findAll.mockResolvedValue({ items: [], total: 0 });

    await service.findAll({ category: 'ACADEMIC' });

    expect(events.findAll).toHaveBeenCalledWith(
      { category: 'ACADEMIC', status: undefined },
      { limit: 100, offset: 0 },
    );
  });
});

describe('EventsService.update', () => {
  it('preserva as vagas ocupadas ao aumentar a capacidade (D2)', async () => {
    const { service } = setup(buildEvent({ max_capacity: 100, available_spots: 50 }));

    const updated = await service.update(EVENT_ID, { max_capacity: 200 });

    expect([updated.max_capacity, updated.available_spots]).toEqual([200, 150]);
  });

  it('responde 409 com capacidade menor que as vagas ocupadas', async () => {
    const { service, events } = setup(buildEvent({ max_capacity: 3, available_spots: 1 }));

    await expect(service.update(EVENT_ID, { max_capacity: 1 })).rejects.toThrow(
      new ConflictException('max_capacity cannot be lower than the 2 occupied spots'),
    );
    expect(events.save).not.toHaveBeenCalled();
  });

  it('marca SOLD_OUT quando a capacidade fica igual às ocupadas', async () => {
    const { service } = setup(buildEvent({ max_capacity: 3, available_spots: 2 }));

    const updated = await service.update(EVENT_ID, { max_capacity: 1 });

    expect([updated.available_spots, updated.status]).toEqual([0, EventStatus.SOLD_OUT]);
  });

  it('reabre evento SOLD_OUT quando a capacidade aumenta', async () => {
    const { service } = setup(
      buildEvent({ max_capacity: 1, available_spots: 0, status: EventStatus.SOLD_OUT }),
    );

    const updated = await service.update(EVENT_ID, { max_capacity: 2 });

    expect([updated.available_spots, updated.status]).toEqual([1, EventStatus.PUBLISHED]);
  });

  it('altera só os campos enviados e registra event.updated', async () => {
    const { service, outbox } = setup(buildEvent({ description: 'Original' }));

    const updated = await service.update(EVENT_ID, { title: 'Novo título', category: undefined });

    expect(updated.title).toBe('Novo título');
    expect(updated.description).toBe('Original');
    expect(updated.category).toBe('WORKSHOP');
    expect(enqueuedActivities(outbox)).toEqual([
      expect.objectContaining({
        action: 'event.updated',
        data: expect.objectContaining({ changed_fields: ['title'] }),
      }),
    ]);
  });

  it('responde 400 com fim anterior ao início já gravado', async () => {
    const { service } = setup();

    await expect(
      service.update(EVENT_ID, { end_at: `${FUTURE_YEAR}-11-19T08:00:00-04:00` }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('responde 404 para evento inexistente', async () => {
    const { service, events } = setup();
    events.findByIdForUpdate.mockResolvedValue(null);

    await expect(service.update(EVENT_ID, { title: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('avisa o tickets-service na mesma transação ao cancelar o evento (D33)', async () => {
    const { service, outbox, manager } = setup();

    await service.update(EVENT_ID, { status: EventStatus.CANCELLED });

    expect(outbox.enqueue).toHaveBeenCalledWith(manager, expect.anything());
    expect(enqueuedActivities(outbox)).toEqual([
      expect.objectContaining({ action: 'event.cancelled', level: 'WARNING' }),
    ]);
    expect(enqueuedEventNotices(outbox)).toEqual([
      expect.objectContaining({
        type: 'event.cancelled',
        event_id: EVENT_ID,
        source: 'events-service',
      }),
    ]);
  });

  it('não avisa de novo quando o evento já estava cancelado', async () => {
    const { service, outbox } = setup(buildEvent({ status: EventStatus.CANCELLED }));

    await service.update(EVENT_ID, { status: EventStatus.CANCELLED });

    expect(enqueuedEventNotices(outbox)).toEqual([]);
  });

  it.each([EventStatus.FINISHED, undefined])(
    'não avisa o tickets-service em outras atualizações (status %s)',
    async (status) => {
      const { service, outbox } = setup();

      await service.update(EVENT_ID, { status, title: 'Outro' });

      expect(enqueuedEventNotices(outbox)).toEqual([]);
    },
  );

  it.each([EventStatus.PUBLISHED, EventStatus.SOLD_OUT, EventStatus.FINISHED])(
    'não reabre evento cancelado como %s (D17)',
    async (status) => {
      const { service } = setup(buildEvent({ status: EventStatus.CANCELLED }));

      await expect(service.update(EVENT_ID, { status })).rejects.toThrow(
        new ConflictException('Cancelled event cannot be reopened'),
      );
    },
  );
});

describe('EventsService.remove', () => {
  it('trava o evento, remove e avisa o tickets-service na mesma transação', async () => {
    const { service, manager, events, outbox } = setup();

    await service.remove(EVENT_ID);

    expect(events.findByIdForUpdate).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(events.delete).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(enqueuedMessages(outbox).map((m) => [m.exchange, m.routing_key])).toEqual([
      ['activities.exchange', 'event.deleted'],
      ['events.exchange', 'event.deleted'],
    ]);
  });

  it('responde 404 sem remover nada quando o evento não existe', async () => {
    const { service, events, outbox } = setup();
    events.findByIdForUpdate.mockResolvedValue(null);

    await expect(service.remove(EVENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(events.delete).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('EventsService.reserveSpot', () => {
  it('reserva com UPDATE condicional, registra a reserva pelo ticket_id e grava event.spot_reserved', async () => {
    const { service, manager, events, reservations, outbox, spots } = setup();

    const event = await service.reserveSpot(EVENT_ID, TICKET_ID);

    expect(event.available_spots).toBe(1);
    expect(events.reserveSpot).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(reservations.insert).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        ticket_id: TICKET_ID,
        event_id: EVENT_ID,
        status: ReservationStatus.RESERVED,
      }),
    );
    expect(enqueuedActivities(outbox)).toEqual([
      expect.objectContaining({
        action: 'event.spot_reserved',
        data: expect.objectContaining({ available_spots: 1, ticket_id: TICKET_ID }),
      }),
    ]);
    expect(spots).toHaveBeenCalledWith('reserve', 'success');
  });

  it('devolve a mesma vaga, sem reservar outra, quando o ticket_id já tem reserva (D30)', async () => {
    const { service, events, reservations, outbox, spots } = setup();
    reservations.findByTicketId.mockResolvedValue(reservation());

    await expect(service.reserveSpot(EVENT_ID, TICKET_ID)).resolves.toMatchObject({ id: EVENT_ID });

    expect(events.reserveSpot).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(spots).toHaveBeenCalledWith('reserve', 'replayed');
  });

  it('recusa com 409 a reserva de um ticket_id cuja vaga já foi devolvida', async () => {
    const { service, events, reservations } = setup();
    reservations.findByTicketId.mockResolvedValue(
      reservation({ status: ReservationStatus.RELEASED }),
    );

    await expect(service.reserveSpot(EVENT_ID, TICKET_ID)).rejects.toThrow(
      new ConflictException('Reservation for this ticket was already released'),
    );
    expect(events.reserveSpot).not.toHaveBeenCalled();
  });

  it('usa a reserva gravada por uma chamada simultânea com o mesmo ticket_id', async () => {
    const { service, reservations, dataSource } = setup();
    reservations.insert.mockRejectedValue(uniqueViolation('PK_spot_reservations'));
    reservations.findByTicketId.mockResolvedValueOnce(null).mockResolvedValueOnce(reservation());

    await expect(service.reserveSpot(EVENT_ID, TICKET_ID)).resolves.toMatchObject({ id: EVENT_ID });
    // A primeira transação é desfeita, com o decremento; a segunda só lê a reserva vencedora.
    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
  });

  it('responde 404 quando o evento não existe', async () => {
    const { service, events, spots } = setup();
    events.findById.mockResolvedValue(null);

    await expect(service.reserveSpot(EVENT_ID, TICKET_ID)).rejects.toThrow(
      new NotFoundException('Event not found'),
    );
    expect(events.reserveSpot).not.toHaveBeenCalled();
    expect(spots).toHaveBeenCalledWith('reserve', 'rejected');
  });

  it('responde 400 para evento que já terminou, mesmo SOLD_OUT (D25)', async () => {
    const { service, events } = setup(
      buildEvent({
        status: EventStatus.SOLD_OUT,
        available_spots: 0,
        end_at: new Date(Date.now() - 60_000),
      }),
    );

    await expect(service.reserveSpot(EVENT_ID, TICKET_ID)).rejects.toThrow(
      new BadRequestException('Event has already ended'),
    );
    expect(events.reserveSpot).not.toHaveBeenCalled();
  });

  it('aceita reserva em evento que já começou, mas ainda não terminou', async () => {
    const { service } = setup(
      buildEvent({
        start_at: new Date(Date.now() - 60 * 60_000),
        end_at: new Date(Date.now() + 60 * 60_000),
      }),
    );

    await expect(service.reserveSpot(EVENT_ID, TICKET_ID)).resolves.toBeDefined();
  });

  it.each([EventStatus.CANCELLED, EventStatus.FINISHED])('responde 400 para evento %s', async (status) => {
    const { service } = setup(buildEvent({ status }));

    await expect(service.reserveSpot(EVENT_ID, TICKET_ID)).rejects.toThrow(
      new BadRequestException('Event is not open for registrations'),
    );
  });

  it('responde 409 para evento SOLD_OUT, e não 400 (D11)', async () => {
    const { service } = setup(buildEvent({ status: EventStatus.SOLD_OUT, available_spots: 0 }));

    await expect(service.reserveSpot(EVENT_ID, TICKET_ID)).rejects.toThrow(
      new ConflictException('Event is sold out'),
    );
  });

  it.each([
    [buildEvent({ status: EventStatus.SOLD_OUT, available_spots: 0 }), 'Event is sold out'],
    [buildEvent({ status: EventStatus.CANCELLED }), 'Event is not open for registrations'],
    [buildEvent({ end_at: new Date(Date.now() - 1_000) }), 'Event has already ended'],
  ])('responde 409 quando perde a corrida no UPDATE condicional (%#)', async (after, message) => {
    const { service, events, reservations, spots } = setup();
    events.reserveSpot.mockResolvedValue(null);
    events.findById.mockResolvedValueOnce(buildEvent()).mockResolvedValueOnce(after);

    const error = await service.reserveSpot(EVENT_ID, TICKET_ID).catch((e) => e);

    expect(error).toBeInstanceOf(ReservationRaceError);
    expect(error.message).toBe(message);
    expect(reservations.insert).not.toHaveBeenCalled();
    expect(spots).toHaveBeenCalledWith('reserve', 'conflict');
  });
});

describe('EventsService.releaseReservation', () => {
  it('devolve a vaga uma vez, marca a reserva e grava event.spot_released (D31)', async () => {
    const { service, manager, events, reservations, outbox, spots } = setup(
      buildEvent({ available_spots: 0, status: EventStatus.SOLD_OUT }),
    );

    await expect(
      service.releaseReservation(TICKET_ID, EVENT_ID, 'ticket_cancelled'),
    ).resolves.toBe('success');

    expect(reservations.markReleased).toHaveBeenCalledWith(manager, TICKET_ID);
    expect(events.releaseSpot).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(enqueuedActivities(outbox)).toEqual([
      expect.objectContaining({
        action: 'event.spot_released',
        data: expect.objectContaining({ ticket_id: TICKET_ID, reason: 'ticket_cancelled' }),
      }),
    ]);
    expect(spots).toHaveBeenCalledWith('release', 'success');
  });

  it('ignora uma devolução repetida, sem mexer nas vagas', async () => {
    const { service, events, reservations, outbox } = setup();
    reservations.findByTicketIdForUpdate.mockResolvedValue(
      reservation({ status: ReservationStatus.RELEASED }),
    );

    await expect(service.releaseReservation(TICKET_ID, EVENT_ID, 'issue_failed')).resolves.toBe(
      'duplicate',
    );
    expect(events.releaseSpot).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('registra a devolução sem reserva, para recusar uma reserva atrasada do mesmo ingresso', async () => {
    const { service, manager, events, reservations } = setup();
    reservations.findByTicketIdForUpdate.mockResolvedValue(null);

    await expect(service.releaseReservation(TICKET_ID, EVENT_ID, 'issue_failed')).resolves.toBe(
      'not_reserved',
    );
    expect(reservations.insert).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ ticket_id: TICKET_ID, status: ReservationStatus.RELEASED }),
    );
    expect(events.releaseSpot).not.toHaveBeenCalled();
  });

  it('mantém a reserva devolvida quando o evento já foi removido', async () => {
    const { service, events, outbox, spots } = setup();
    events.releaseSpot.mockResolvedValue(null);
    events.findById.mockResolvedValue(null);

    await expect(
      service.releaseReservation(TICKET_ID, EVENT_ID, 'ticket_cancelled'),
    ).resolves.toBe('event_missing');
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(spots).toHaveBeenCalledWith('release', 'event_missing');
  });

  it('não ultrapassa a capacidade quando o evento já está cheio', async () => {
    const { service, events } = setup();
    events.releaseSpot.mockResolvedValue(null);

    await expect(
      service.releaseReservation(TICKET_ID, EVENT_ID, 'ticket_cancelled'),
    ).resolves.toBe('at_capacity');
  });
});

describe('EventsService.getHistory', () => {
  it('consulta o logs-service quando o evento existe', async () => {
    const { service, logsClient } = setup();

    await service.getHistory(EVENT_ID);

    expect(logsClient.getHistory).toHaveBeenCalledWith('event', EVENT_ID, {
      limit: 500,
      offset: 0,
    });
  });

  it('responde 404 sem consultar o logs-service', async () => {
    const { service, events, logsClient } = setup();
    events.findById.mockResolvedValue(null);

    await expect(service.getHistory(EVENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(logsClient.getHistory).not.toHaveBeenCalled();
  });
});
