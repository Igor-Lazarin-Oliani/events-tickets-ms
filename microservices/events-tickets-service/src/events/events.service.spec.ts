import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  buildEvent,
  enqueuedActivities,
  EVENT_ID,
  fakeDataSource,
  fakeLogsClient,
  fakeOutbox,
  FUTURE_YEAR,
  metricsWithSpies,
} from '../testing/fakes';
import { EventModality, EventStatus } from './entities/event.entity';
import { EventsService } from './events.service';

const createDto = {
  title: 'Workshop Docker',
  modality: EventModality.ONLINE,
  location: 'https://example.com/live',
  start_at: '2026-11-20T08:00:00-04:00',
  end_at: '2026-11-20T18:00:00-04:00',
  max_capacity: 5,
};

const cancelledTickets = [
  { id: '11111111-1111-4111-8111-111111111111', ticket_code: 'EVT-2026-AAAAAA' },
  { id: '22222222-2222-4222-8222-222222222222', ticket_code: 'EVT-2026-BBBBBB' },
];

function setup(current = buildEvent()) {
  const { dataSource, manager } = fakeDataSource();
  const events = {
    create: jest.fn(async (_manager: unknown, data: object) => buildEvent(data)),
    findAll: jest.fn(),
    findById: jest.fn(async () => current),
    findByIdForUpdate: jest.fn(async () => current),
    save: jest.fn(async (_manager: unknown, event: unknown) => event),
    delete: jest.fn(async () => true),
  };
  const tickets = { cancelActiveForEvent: jest.fn(async () => cancelledTickets) };
  const outbox = fakeOutbox();
  const logsClient = fakeLogsClient();
  const { metrics, cancelled } = metricsWithSpies();
  const service = new EventsService(
    dataSource as never,
    events as never,
    tickets as never,
    outbox as never,
    metrics,
    logsClient as never,
  );
  return { service, dataSource, manager, events, tickets, outbox, logsClient, cancelled };
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

  it('registra event.created na mesma transação', async () => {
    const { service, outbox } = setup();

    await service.create(createDto);

    expect(enqueuedActivities(outbox)).toEqual([
      expect.objectContaining({ action: 'event.created', entity_type: 'event' }),
    ]);
  });

  it('responde 400 quando o fim não é posterior ao início', async () => {
    const { service, dataSource } = setup();

    await expect(
      service.create({ ...createDto, end_at: createDto.start_at }),
    ).rejects.toThrow(new BadRequestException('end_at must be after start_at'));
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

  it('devolve a página e o total do repositório', async () => {
    const { service, events } = setup();
    const page = { items: [buildEvent()], total: 7 };
    events.findAll.mockResolvedValue(page);

    await expect(service.findAll({ limit: 1, offset: 3 })).resolves.toBe(page);
    expect(events.findAll).toHaveBeenCalledWith(expect.anything(), { limit: 1, offset: 3 });
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

    const updated = await service.update(EVENT_ID, { title: 'Novo título' });

    expect(updated.title).toBe('Novo título');
    expect(updated.description).toBe('Original');
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
    events.findByIdForUpdate.mockResolvedValue(null as never);

    await expect(service.update(EVENT_ID, { title: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('cancela os ingressos ativos na mesma transação ao cancelar o evento', async () => {
    const { service, manager, tickets, outbox, cancelled } = setup();

    await service.update(EVENT_ID, { status: EventStatus.CANCELLED });

    expect(tickets.cancelActiveForEvent).toHaveBeenCalledWith(manager, EVENT_ID);
    const activities = enqueuedActivities(outbox);
    expect(activities.map((activity) => activity.action)).toEqual([
      'event.cancelled',
      'ticket.cancelled',
      'ticket.cancelled',
    ]);
    expect(activities[0].data).toMatchObject({ tickets_cancelled: 2 });
    expect(activities[1]).toMatchObject({
      entity_id: cancelledTickets[0].id,
      data: { reason: 'event_cancelled', event_id: EVENT_ID },
    });
    expect(cancelled).toHaveBeenCalledWith(2);
  });

  it('não cancela ingressos de novo quando o evento já estava cancelado', async () => {
    const { service, tickets } = setup(buildEvent({ status: EventStatus.CANCELLED }));

    await service.update(EVENT_ID, { status: EventStatus.CANCELLED });

    expect(tickets.cancelActiveForEvent).not.toHaveBeenCalled();
  });

  it.each([EventStatus.FINISHED, undefined])(
    'não cancela ingressos em outras atualizações (status %s)',
    async (status) => {
      const { service, tickets } = setup();

      await service.update(EVENT_ID, { status, title: 'Outro' });

      expect(tickets.cancelActiveForEvent).not.toHaveBeenCalled();
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

  it('aceita alterar outros campos de evento cancelado', async () => {
    const { service } = setup(buildEvent({ status: EventStatus.CANCELLED }));

    const updated = await service.update(EVENT_ID, { title: 'Novo título' });

    expect(updated.status).toBe(EventStatus.CANCELLED);
  });
});

describe('EventsService.remove', () => {
  it('trava o evento, cancela os ingressos e remove na mesma transação', async () => {
    const { service, manager, events, tickets, outbox, cancelled } = setup();

    await service.remove(EVENT_ID);

    expect(events.findByIdForUpdate).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(tickets.cancelActiveForEvent).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(events.delete).toHaveBeenCalledWith(manager, EVENT_ID);
    expect(enqueuedActivities(outbox).map((activity) => activity.action)).toEqual([
      'event.deleted',
      'ticket.cancelled',
      'ticket.cancelled',
    ]);
    expect(cancelled).toHaveBeenCalledWith(2);
  });

  it('responde 404 sem remover nada quando o evento não existe', async () => {
    const { service, events, tickets } = setup();
    events.findByIdForUpdate.mockResolvedValue(null as never);

    await expect(service.remove(EVENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(tickets.cancelActiveForEvent).not.toHaveBeenCalled();
    expect(events.delete).not.toHaveBeenCalled();
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

  it('repassa a paginação pedida, para eventos com mais atividades que uma página', async () => {
    const { service, logsClient } = setup();

    await service.getHistory(EVENT_ID, { limit: 500, offset: 500 });

    expect(logsClient.getHistory).toHaveBeenCalledWith('event', EVENT_ID, {
      limit: 500,
      offset: 500,
    });
  });

  it('responde 404 sem consultar o logs-service', async () => {
    const { service, events, logsClient } = setup();
    events.findById.mockResolvedValue(null as never);

    await expect(service.getHistory(EVENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(logsClient.getHistory).not.toHaveBeenCalled();
  });
});
