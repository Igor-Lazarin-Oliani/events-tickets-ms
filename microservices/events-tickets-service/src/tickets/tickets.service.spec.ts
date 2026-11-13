import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { EventStatus } from '../events/entities/event.entity';
import {
  buildEvent,
  enqueuedActivities,
  EVENT_ID,
  EVENT_START,
  fakeDataSource,
  fakeLogsClient,
  fakeOutbox,
  metricsWithSpies,
  TICKET_ID,
} from '../testing/fakes';
import { ACTIVE_PARTICIPANT_INDEX, TicketStatus } from './entities/ticket.entity';
import { TicketsService } from './tickets.service';

const dto = {
  event_id: EVENT_ID,
  participant_name: 'Maria Silva',
  participant_email: 'maria@example.com',
  participant_document: '2026123456',
};

function uniqueViolation(constraint: string): QueryFailedError {
  const driverError = Object.assign(new Error('duplicate key'), { code: '23505', constraint });
  return new QueryFailedError('INSERT', [], driverError);
}

function storedTicket(status: TicketStatus) {
  return {
    id: TICKET_ID,
    ticket_code: 'EVT-2026-A8F9K2',
    event_id: EVENT_ID,
    modality_tier: 'STANDARD',
    status,
  };
}

function setup() {
  const { dataSource, manager } = fakeDataSource();
  const tickets = {
    findAll: jest.fn(),
    findByIdOrCode: jest.fn(async () => storedTicket(TicketStatus.CONFIRMED)),
    findActiveRegistration: jest.fn(async () => null),
    insertWithUniqueCode: jest.fn(async (_manager: unknown, data: object) => ({
      id: TICKET_ID,
      ticket_code: 'EVT-2026-A8F9K2',
      ...data,
    })),
    updateIfStatus: jest.fn(async () => true),
  };
  const events = {
    findById: jest.fn(async () => buildEvent()),
    reserveSpot: jest.fn(async () => buildEvent({ available_spots: 1 })),
    releaseSpot: jest.fn(async () => buildEvent()),
  };
  const outbox = fakeOutbox();
  const logsClient = fakeLogsClient();
  const { metrics, issued, cancelled, spots } = metricsWithSpies();
  const service = new TicketsService(
    dataSource as never,
    tickets as never,
    events as never,
    outbox as never,
    metrics,
    logsClient as never,
  );
  return { service, dataSource, manager, tickets, events, outbox, logsClient, issued, cancelled, spots };
}

describe('TicketsService.create', () => {
  it('reserva a vaga e salva o ingresso na mesma transação, com o snapshot do evento', async () => {
    const { service, manager, tickets, events, issued } = setup();

    const ticket = await service.create(dto);

    expect(events.reserveSpot).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(tickets.insertWithUniqueCode).toHaveBeenCalledWith(manager, expect.anything());
    expect(ticket.status).toBe(TicketStatus.CONFIRMED);
    expect(ticket.modality_tier).toBe('STANDARD');
    expect(ticket.event_snapshot).toEqual({
      title: 'Workshop Docker',
      category: 'WORKSHOP',
      modality: 'ONLINE',
      location: 'https://example.com/live',
      start_at: EVENT_START.toISOString(),
    });
    expect(issued).toHaveBeenCalledTimes(1);
  });

  it('registra a emissão e a reserva da vaga na outbox, sem dados pessoais', async () => {
    const { service, outbox } = setup();

    await service.create(dto);

    const activities = enqueuedActivities(outbox);
    expect(activities.map((activity) => activity.action)).toEqual([
      'ticket.issued',
      'event.spot_reserved',
    ]);
    expect(activities[1].data).toMatchObject({ available_spots: 1, ticket_id: TICKET_ID });
    const serialized = JSON.stringify(activities);
    expect(serialized).not.toContain(dto.participant_email);
    expect(serialized).not.toContain(dto.participant_document);
    expect(serialized).not.toContain(dto.participant_name);
  });

  it('responde 404 quando o evento não existe, sem abrir transação', async () => {
    const { service, dataSource, events } = setup();
    events.findById.mockResolvedValue(null as never);

    await expect(service.create(dto)).rejects.toThrow(new NotFoundException('Event not found'));
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('responde 400 para evento que já terminou, sem abrir transação (D25)', async () => {
    const { service, dataSource, events } = setup();
    events.findById.mockResolvedValue(buildEvent({ end_at: new Date(Date.now() - 60_000) }));

    await expect(service.create(dto)).rejects.toThrow(
      new BadRequestException('Event has already ended'),
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(events.reserveSpot).not.toHaveBeenCalled();
  });

  it('responde 400 para evento encerrado mesmo que esteja SOLD_OUT', async () => {
    const { service, events } = setup();
    events.findById.mockResolvedValue(
      buildEvent({
        status: EventStatus.SOLD_OUT,
        available_spots: 0,
        end_at: new Date(Date.now() - 60_000),
      }),
    );

    await expect(service.create(dto)).rejects.toThrow(
      new BadRequestException('Event has already ended'),
    );
  });

  it('aceita inscrição em evento que já começou, mas ainda não terminou', async () => {
    const { service, events } = setup();
    events.findById.mockResolvedValue(
      buildEvent({
        start_at: new Date(Date.now() - 60 * 60_000),
        end_at: new Date(Date.now() + 60 * 60_000),
      }),
    );

    await expect(service.create(dto)).resolves.toMatchObject({ status: TicketStatus.CONFIRMED });
  });

  it('responde 409 quando o evento terminou entre a consulta e a reserva', async () => {
    const { service, tickets, events } = setup();
    events.reserveSpot.mockResolvedValue(null as never);
    events.findById
      .mockResolvedValueOnce(buildEvent())
      .mockResolvedValueOnce(buildEvent({ end_at: new Date(Date.now() - 1_000) }));

    await expect(service.create(dto)).rejects.toThrow(
      new ConflictException('Event has already ended'),
    );
    expect(tickets.insertWithUniqueCode).not.toHaveBeenCalled();
  });

  it('responde 404 quando o evento foi removido entre a consulta e a reserva', async () => {
    const { service, tickets, events } = setup();
    events.reserveSpot.mockResolvedValue(null as never);
    events.findById.mockResolvedValueOnce(buildEvent()).mockResolvedValueOnce(null as never);

    await expect(service.create(dto)).rejects.toThrow(new NotFoundException('Event not found'));
    expect(tickets.insertWithUniqueCode).not.toHaveBeenCalled();
  });

  it.each([EventStatus.CANCELLED, EventStatus.FINISHED])('responde 400 para evento %s', async (status) => {
    const { service, dataSource, events } = setup();
    events.findById.mockResolvedValue(buildEvent({ status }));

    await expect(service.create(dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('responde 409 para evento SOLD_OUT, e não 400', async () => {
    const { service, events } = setup();
    events.findById.mockResolvedValue(
      buildEvent({ status: EventStatus.SOLD_OUT, available_spots: 0 }),
    );

    await expect(service.create(dto)).rejects.toThrow(new ConflictException('Event is sold out'));
  });

  it('responde 409 para participante já inscrito, sem reservar vaga', async () => {
    const { service, tickets, events } = setup();
    tickets.findActiveRegistration.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED) as never);

    await expect(service.create(dto)).rejects.toThrow(
      new ConflictException('Participant already registered for this event'),
    );
    expect(events.reserveSpot).not.toHaveBeenCalled();
  });

  it('responde 409 quando a última vaga foi tomada entre a consulta e a reserva', async () => {
    const { service, tickets, events, spots } = setup();
    events.reserveSpot.mockResolvedValue(null as never);
    events.findById
      .mockResolvedValueOnce(buildEvent())
      .mockResolvedValueOnce(buildEvent({ status: EventStatus.SOLD_OUT, available_spots: 0 }));

    await expect(service.create(dto)).rejects.toThrow(new ConflictException('Event is sold out'));
    expect(tickets.insertWithUniqueCode).not.toHaveBeenCalled();
    expect(spots).toHaveBeenCalledWith('reserve', 'conflict');
  });

  it('responde 409 quando o evento fechou entre a consulta e a reserva', async () => {
    const { service, events } = setup();
    events.reserveSpot.mockResolvedValue(null as never);
    events.findById
      .mockResolvedValueOnce(buildEvent())
      .mockResolvedValueOnce(buildEvent({ status: EventStatus.CANCELLED }));

    await expect(service.create(dto)).rejects.toThrow(
      new ConflictException('Event is not open for registrations'),
    );
  });

  it('responde 409 em inscrição simultânea duplicada, desfazendo a reserva', async () => {
    const { service, tickets, outbox, issued } = setup();
    tickets.insertWithUniqueCode.mockRejectedValue(uniqueViolation(ACTIVE_PARTICIPANT_INDEX));

    await expect(service.create(dto)).rejects.toThrow(
      new ConflictException('Participant already registered for this event'),
    );
    // O erro sai do callback da transação: o PostgreSQL desfaz a reserva junto com o resto.
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(issued).not.toHaveBeenCalled();
  });

  it('responde 500 quando o salvamento falha por outro motivo', async () => {
    const { service, tickets, issued } = setup();
    tickets.insertWithUniqueCode.mockRejectedValue(new Error('database down'));

    await expect(service.create(dto)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(issued).not.toHaveBeenCalled();
  });
});

describe('TicketsService.findAll', () => {
  it('aplica a página padrão e repassa só os filtros', async () => {
    const { service, tickets } = setup();
    tickets.findAll.mockResolvedValue({ items: [], total: 0 });

    await service.findAll({ event_id: EVENT_ID });

    expect(tickets.findAll).toHaveBeenCalledWith(
      { event_id: EVENT_ID, participant_email: undefined, status: undefined },
      { limit: 100, offset: 0 },
    );
  });

  it('respeita limit e offset enviados', async () => {
    const { service, tickets } = setup();
    tickets.findAll.mockResolvedValue({ items: [], total: 0 });

    await service.findAll({ status: TicketStatus.CONFIRMED, limit: 10, offset: 20 });

    expect(tickets.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ status: TicketStatus.CONFIRMED }),
      { limit: 10, offset: 20 },
    );
  });
});

describe('TicketsService.findOne', () => {
  it('responde 404 para ingresso inexistente', async () => {
    const { service, tickets } = setup();
    tickets.findByIdOrCode.mockResolvedValue(null as never);

    await expect(service.findOne('EVT-2026-XXXXXX')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TicketsService.update', () => {
  it('realiza o check-in de um ingresso confirmado e registra ticket.checked_in', async () => {
    const { service, manager, tickets, outbox } = setup();

    await service.update(TICKET_ID, { status: TicketStatus.CHECKED_IN });

    expect(tickets.updateIfStatus).toHaveBeenCalledWith(
      manager,
      TICKET_ID,
      TicketStatus.CONFIRMED,
      { status: TicketStatus.CHECKED_IN },
    );
    expect(enqueuedActivities(outbox)[0]).toMatchObject({
      action: 'ticket.checked_in',
      data: { status: TicketStatus.CHECKED_IN },
    });
  });

  it('registra só o nome dos campos alterados, sem os valores', async () => {
    const { service, outbox } = setup();

    await service.update(TICKET_ID, { participant_email: 'novo@example.com' });

    const [activity] = enqueuedActivities(outbox);
    expect(activity.action).toBe('ticket.updated');
    expect(activity.data).toMatchObject({ changed_fields: ['participant_email'] });
    expect(JSON.stringify(activity)).not.toContain('novo@example.com');
  });

  it('responde 409 em check-in repetido', async () => {
    const { service, tickets, dataSource } = setup();
    tickets.findByIdOrCode.mockResolvedValue(storedTicket(TicketStatus.CHECKED_IN));

    await expect(
      service.update(TICKET_ID, { status: TicketStatus.CHECKED_IN }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('responde 409 ao editar ingresso cancelado', async () => {
    const { service, tickets } = setup();
    tickets.findByIdOrCode.mockResolvedValue(storedTicket(TicketStatus.CANCELLED));

    await expect(service.update(TICKET_ID, { participant_name: 'Ana' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('não grava nada quando o corpo está vazio', async () => {
    const { service, dataSource } = setup();

    await service.update(TICKET_ID, {});

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('responde 409 quando outra requisição mudou o status antes', async () => {
    const { service, tickets, outbox } = setup();
    tickets.updateIfStatus.mockResolvedValue(false);

    await expect(service.update(TICKET_ID, { modality_tier: 'VIP' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('responde 409 ao trocar para documento já inscrito no evento', async () => {
    const { service, tickets } = setup();
    tickets.updateIfStatus.mockRejectedValue(uniqueViolation(ACTIVE_PARTICIPANT_INDEX));

    await expect(
      service.update(TICKET_ID, { participant_document: '999' }),
    ).rejects.toThrow(new ConflictException('Participant already registered for this event'));
  });
});

describe('TicketsService.cancel', () => {
  it.each([TicketStatus.CONFIRMED, TicketStatus.CHECKED_IN])(
    'cancela ingresso %s e devolve a vaga na mesma transação',
    async (status) => {
      const { service, manager, tickets, events, outbox, cancelled, spots } = setup();
      tickets.findByIdOrCode.mockResolvedValue(storedTicket(status));

      await service.cancel(TICKET_ID);

      expect(tickets.updateIfStatus).toHaveBeenCalledWith(manager, TICKET_ID, status, {
        status: TicketStatus.CANCELLED,
      });
      expect(events.releaseSpot).toHaveBeenCalledWith(manager, EVENT_ID);
      expect(enqueuedActivities(outbox).map((activity) => activity.action)).toEqual([
        'ticket.cancelled',
        'event.spot_released',
      ]);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(spots).toHaveBeenCalledWith('release', 'success');
    },
  );

  it('responde 409 e não devolve vaga se já estiver cancelado', async () => {
    const { service, tickets, dataSource } = setup();
    tickets.findByIdOrCode.mockResolvedValue(storedTicket(TicketStatus.CANCELLED));

    await expect(service.cancel(TICKET_ID)).rejects.toThrow(
      new ConflictException('Ticket is already cancelled'),
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('não devolve vaga quando perde a corrida para outro cancelamento', async () => {
    const { service, tickets, events } = setup();
    tickets.updateIfStatus.mockResolvedValue(false);

    await expect(service.cancel(TICKET_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(events.releaseSpot).not.toHaveBeenCalled();
  });

  it('mantém o cancelamento se o evento não existir mais', async () => {
    const { service, events, outbox, cancelled, spots } = setup();
    events.releaseSpot.mockResolvedValue(null as never);
    events.findById.mockResolvedValue(null as never);

    await expect(service.cancel(TICKET_ID)).resolves.toBeDefined();
    expect(enqueuedActivities(outbox).map((activity) => activity.action)).toEqual([
      'ticket.cancelled',
    ]);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(spots).toHaveBeenCalledWith('release', 'event_missing');
  });

  it('não ultrapassa a capacidade quando o evento já está cheio', async () => {
    const { service, events, spots } = setup();
    events.releaseSpot.mockResolvedValue(null as never);

    await service.cancel(TICKET_ID);

    expect(spots).toHaveBeenCalledWith('release', 'at_capacity');
  });
});

describe('TicketsService.getHistory', () => {
  it('busca o histórico pelo UUID, mesmo quando recebe o ticket_code', async () => {
    const { service, logsClient } = setup();

    await service.getHistory('EVT-2026-A8F9K2');

    expect(logsClient.getHistory).toHaveBeenCalledWith('ticket', TICKET_ID, {
      limit: 500,
      offset: 0,
    });
  });

  it('repassa a paginação pedida ao logs-service', async () => {
    const { service, logsClient } = setup();

    await service.getHistory(TICKET_ID, { limit: 20, offset: 40 });

    expect(logsClient.getHistory).toHaveBeenCalledWith('ticket', TICKET_ID, {
      limit: 20,
      offset: 40,
    });
  });

  it('responde 404 sem consultar o logs-service quando o ingresso não existe', async () => {
    const { service, tickets, logsClient } = setup();
    tickets.findByIdOrCode.mockResolvedValue(null as never);

    await expect(service.getHistory(TICKET_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(logsClient.getHistory).not.toHaveBeenCalled();
  });
});
