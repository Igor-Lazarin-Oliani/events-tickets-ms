import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { EventsServiceUnavailableError } from '../events-integration/events-client.service';
import {
  enqueuedActivities,
  enqueuedMessages,
  enqueuedSpotReleases,
  EVENT_ID,
  EVENT_START,
  fakeDataSource,
  fakeLogsClient,
  fakeOutbox,
  metricsWithSpies,
  reservedEvent,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
      ticket_code: 'EVT-2026-A8F9K2',
      ...data,
    })),
    updateIfStatus: jest.fn(async () => true),
    cancelActiveForEvent: jest.fn(async () => [
      { id: '11111111-1111-4111-8111-111111111111', ticket_code: 'EVT-2026-AAAAAA' },
      { id: '22222222-2222-4222-8222-222222222222', ticket_code: 'EVT-2026-BBBBBB' },
    ]),
  };
  const closedEvents = {
    lock: jest.fn(async () => undefined),
    isClosed: jest.fn(async () => false),
    markClosed: jest.fn(async () => undefined),
  };
  const eventsClient = { reserveSpot: jest.fn(async () => reservedEvent()) };
  const outbox = fakeOutbox();
  const logsClient = fakeLogsClient();
  const spies = metricsWithSpies();
  const service = new TicketsService(
    dataSource as never,
    tickets as never,
    closedEvents as never,
    outbox as never,
    eventsClient as never,
    spies.metrics,
    logsClient as never,
  );
  return {
    service,
    dataSource,
    manager,
    tickets,
    closedEvents,
    eventsClient,
    outbox,
    logsClient,
    ...spies,
  };
}

describe('TicketsService.create', () => {
  it('reserva a vaga no events-service com o id do ingresso e salva o ingresso com o snapshot', async () => {
    const { service, manager, tickets, eventsClient, issued, reservations } = setup();

    const ticket = await service.create(dto);

    const [eventId, ticketId] = eventsClient.reserveSpot.mock.calls[0] as unknown as string[];
    expect(eventId).toBe(EVENT_ID);
    expect(ticketId).toMatch(UUID);
    // O id usado na reserva é o mesmo do ingresso: é a chave da devolução da vaga.
    expect(ticket.id).toBe(ticketId);
    expect(tickets.insertWithUniqueCode).toHaveBeenCalledWith(manager, expect.anything());
    expect(ticket.status).toBe(TicketStatus.CONFIRMED);
    expect(ticket.modality_tier).toBe('STANDARD');
    expect(ticket.event_snapshot).toEqual({
      title: 'Workshop Docker',
      category: 'WORKSHOP',
      modality: 'ONLINE',
      location: 'https://example.com/live',
      start_at: EVENT_START,
    });
    expect(issued).toHaveBeenCalledTimes(1);
    expect(reservations).toHaveBeenCalledWith('reserved');
  });

  it('registra ticket.issued na outbox, sem dados pessoais e sem pedir devolução', async () => {
    const { service, outbox } = setup();

    await service.create(dto);

    const activities = enqueuedActivities(outbox);
    expect(activities.map((activity) => activity.action)).toEqual(['ticket.issued']);
    expect(activities[0].source).toBe('tickets-service');
    expect(enqueuedSpotReleases(outbox)).toEqual([]);
    const serialized = JSON.stringify(enqueuedMessages(outbox));
    expect(serialized).not.toContain(dto.participant_email);
    expect(serialized).not.toContain(dto.participant_document);
    expect(serialized).not.toContain(dto.participant_name);
  });

  it('trava o evento e confere se ele foi encerrado dentro da transação do ingresso (D32)', async () => {
    const { service, manager, closedEvents } = setup();

    await service.create(dto);

    expect(closedEvents.lock).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(closedEvents.isClosed).toHaveBeenLastCalledWith(EVENT_ID, manager);
  });

  it('responde 400 sem chamar o events-service quando o evento já foi encerrado', async () => {
    const { service, closedEvents, eventsClient } = setup();
    closedEvents.isClosed.mockResolvedValue(true);

    await expect(service.create(dto)).rejects.toThrow(
      new BadRequestException('Event is not open for registrations'),
    );
    expect(eventsClient.reserveSpot).not.toHaveBeenCalled();
  });

  it('responde 409 para participante já inscrito, sem reservar vaga', async () => {
    const { service, tickets, eventsClient } = setup();
    tickets.findActiveRegistration.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED) as never);

    await expect(service.create(dto)).rejects.toThrow(
      new ConflictException('Participant already registered for this event'),
    );
    expect(eventsClient.reserveSpot).not.toHaveBeenCalled();
  });

  it.each([
    new NotFoundException('Event not found'),
    new BadRequestException('Event has already ended'),
    new ConflictException('Event is sold out'),
  ])('repassa a recusa do events-service (%s) sem salvar nem compensar', async (refusal) => {
    const { service, dataSource, eventsClient, outbox, reservations } = setup();
    eventsClient.reserveSpot.mockRejectedValue(refusal);

    await expect(service.create(dto)).rejects.toBe(refusal);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(reservations).toHaveBeenCalledWith('rejected');
  });

  it('responde 503 e pede a devolução quando o events-service não dá resposta definitiva', async () => {
    const { service, dataSource, eventsClient, outbox, compensations, reservations } = setup();
    eventsClient.reserveSpot.mockRejectedValue(new EventsServiceUnavailableError());

    await expect(service.create(dto)).rejects.toBeInstanceOf(EventsServiceUnavailableError);

    const [ticketId] = (eventsClient.reserveSpot.mock.calls[0] as unknown as string[]).slice(1);
    expect(enqueuedSpotReleases(outbox)).toEqual([
      expect.objectContaining({
        type: 'spot.release_requested',
        event_id: EVENT_ID,
        ticket_id: ticketId,
        reason: 'issue_failed',
      }),
    ]);
    // A devolução é gravada direto, fora de transação: não há mudança local a acompanhar.
    expect(outbox.enqueue).toHaveBeenCalledWith(dataSource.manager, expect.anything());
    expect(reservations).toHaveBeenCalledWith('unavailable');
    expect(compensations).toHaveBeenCalledWith('queued');
  });

  it('responde 409 em inscrição simultânea duplicada e devolve a vaga reservada', async () => {
    const { service, tickets, outbox, issued, compensations } = setup();
    tickets.insertWithUniqueCode.mockRejectedValue(uniqueViolation(ACTIVE_PARTICIPANT_INDEX));

    await expect(service.create(dto)).rejects.toThrow(
      new ConflictException('Participant already registered for this event'),
    );
    expect(enqueuedActivities(outbox)).toEqual([]);
    expect(enqueuedSpotReleases(outbox)).toEqual([
      expect.objectContaining({ event_id: EVENT_ID, reason: 'issue_failed' }),
    ]);
    expect(compensations).toHaveBeenCalledWith('queued');
    expect(issued).not.toHaveBeenCalled();
  });

  it('responde 409 e devolve a vaga quando o evento foi encerrado durante a inscrição', async () => {
    const { service, tickets, closedEvents, outbox } = setup();
    closedEvents.isClosed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(service.create(dto)).rejects.toThrow(
      new ConflictException('Event is not open for registrations'),
    );
    expect(tickets.insertWithUniqueCode).not.toHaveBeenCalled();
    expect(enqueuedSpotReleases(outbox)).toHaveLength(1);
  });

  it('responde 500 e devolve a vaga quando o salvamento falha por outro motivo', async () => {
    const { service, tickets, outbox, issued } = setup();
    tickets.insertWithUniqueCode.mockRejectedValue(new Error('database down'));

    await expect(service.create(dto)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(enqueuedSpotReleases(outbox)).toHaveLength(1);
    expect(issued).not.toHaveBeenCalled();
  });

  it('registra a compensação perdida quando nem a outbox pode ser gravada', async () => {
    const { service, tickets, outbox, compensations } = setup();
    tickets.insertWithUniqueCode.mockRejectedValue(new Error('database down'));
    outbox.enqueue.mockRejectedValue(new Error('database down'));

    await expect(service.create(dto)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(compensations).toHaveBeenCalledWith('failed');
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
    'cancela ingresso %s e grava o pedido de devolução da vaga na mesma transação (D31)',
    async (status) => {
      const { service, manager, tickets, outbox, cancelled } = setup();
      tickets.findByIdOrCode.mockResolvedValue(storedTicket(status));

      await service.cancel(TICKET_ID);

      expect(tickets.updateIfStatus).toHaveBeenCalledWith(manager, TICKET_ID, status, {
        status: TicketStatus.CANCELLED,
      });
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue).toHaveBeenCalledWith(manager, expect.anything());
      expect(enqueuedActivities(outbox)).toEqual([
        expect.objectContaining({
          action: 'ticket.cancelled',
          level: 'WARNING',
          data: expect.objectContaining({ previous_status: status, reason: 'requested' }),
        }),
      ]);
      expect(enqueuedSpotReleases(outbox)).toEqual([
        expect.objectContaining({
          event_id: EVENT_ID,
          ticket_id: TICKET_ID,
          reason: 'ticket_cancelled',
        }),
      ]);
      expect(cancelled).toHaveBeenCalledTimes(1);
    },
  );

  it('responde 409 e não pede devolução se já estiver cancelado', async () => {
    const { service, tickets, dataSource } = setup();
    tickets.findByIdOrCode.mockResolvedValue(storedTicket(TicketStatus.CANCELLED));

    await expect(service.cancel(TICKET_ID)).rejects.toThrow(
      new ConflictException('Ticket is already cancelled'),
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('não pede devolução quando perde a corrida para outro cancelamento', async () => {
    const { service, tickets, outbox } = setup();
    tickets.updateIfStatus.mockResolvedValue(false);

    await expect(service.cancel(TICKET_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('TicketsService.cancelAllForEvent', () => {
  it('registra o evento como encerrado e cancela os ingressos ativos na mesma transação (D33)', async () => {
    const { service, manager, tickets, closedEvents, outbox, cancelled } = setup();

    await expect(service.cancelAllForEvent(EVENT_ID, 'event_cancelled')).resolves.toBe(2);

    expect(closedEvents.lock).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(closedEvents.markClosed).toHaveBeenCalledWith(manager, EVENT_ID, 'event_cancelled');
    expect(tickets.cancelActiveForEvent).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(enqueuedActivities(outbox)).toEqual([
      expect.objectContaining({
        action: 'ticket.cancelled',
        entity_id: '11111111-1111-4111-8111-111111111111',
        data: expect.objectContaining({ reason: 'event_cancelled', event_id: EVENT_ID }),
      }),
      expect.objectContaining({ action: 'ticket.cancelled' }),
    ]);
    // O evento não aceita mais inscrições: as vagas não voltam.
    expect(enqueuedSpotReleases(outbox)).toEqual([]);
    expect(cancelled).toHaveBeenCalledWith(2);
  });

  it('é idempotente: uma entrega repetida não cancela nem registra nada de novo', async () => {
    const { service, tickets, outbox, cancelled } = setup();
    tickets.cancelActiveForEvent.mockResolvedValue([]);

    await expect(service.cancelAllForEvent(EVENT_ID, 'event_deleted')).resolves.toBe(0);

    expect(enqueuedMessages(outbox)).toEqual([]);
    expect(cancelled).not.toHaveBeenCalled();
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
