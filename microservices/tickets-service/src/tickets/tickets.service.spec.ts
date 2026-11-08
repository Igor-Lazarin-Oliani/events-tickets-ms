import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { ACTIVE_PARTICIPANT_INDEX, TicketStatus } from './entities/ticket.entity';
import { TicketsService } from './tickets.service';

const EVENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const TICKET_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const openEvent = {
  id: EVENT_ID,
  title: 'Workshop Docker',
  category: 'WORKSHOP',
  modality: 'ONLINE',
  location: 'https://example.com/live',
  start_at: '2026-11-20T12:00:00Z',
  available_spots: 2,
  status: 'PUBLISHED',
};

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
  return { id: TICKET_ID, event_id: EVENT_ID, status };
}

function setup() {
  const repository = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => ({ id: TICKET_ID, ...value })),
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const eventsClient = {
    getEventById: jest.fn(async () => openEvent),
    reserveSpot: jest.fn(async () => openEvent),
    releaseSpot: jest.fn(async () => openEvent),
  };
  const metrics = new MetricsService();
  const issued = jest.spyOn(metrics, 'incrementTicketsIssued');
  const cancelled = jest.spyOn(metrics, 'incrementTicketsCancelled');
  const service = new TicketsService(repository as never, eventsClient as never, metrics);
  return { service, repository, eventsClient, issued, cancelled };
}

describe('TicketsService.create', () => {
  it('reserva a vaga e salva o ingresso com código e snapshot do evento', async () => {
    const { service, repository, eventsClient, issued } = setup();
    repository.findOne.mockResolvedValue(null);

    const ticket = await service.create(dto);

    expect(eventsClient.reserveSpot).toHaveBeenCalledWith(EVENT_ID);
    expect(ticket.ticket_code).toMatch(/^EVT-2026-[A-Z0-9]{6}$/);
    expect(ticket.status).toBe(TicketStatus.CONFIRMED);
    expect(ticket.modality_tier).toBe('STANDARD');
    expect(ticket.event_snapshot).toEqual({
      title: openEvent.title,
      category: openEvent.category,
      modality: openEvent.modality,
      location: openEvent.location,
      start_at: openEvent.start_at,
    });
    expect(issued).toHaveBeenCalledTimes(1);
  });

  it('propaga 404 quando o evento não existe e não reserva vaga', async () => {
    const { service, eventsClient } = setup();
    eventsClient.getEventById.mockRejectedValue(new NotFoundException('Event not found'));

    await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(eventsClient.reserveSpot).not.toHaveBeenCalled();
  });

  it.each(['CANCELLED', 'FINISHED'])('responde 400 para evento %s', async (status) => {
    const { service, eventsClient } = setup();
    eventsClient.getEventById.mockResolvedValue({ ...openEvent, status });

    await expect(service.create(dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(eventsClient.reserveSpot).not.toHaveBeenCalled();
  });

  it('responde 409 para evento SOLD_OUT, e não 400', async () => {
    const { service, eventsClient } = setup();
    eventsClient.getEventById.mockResolvedValue({
      ...openEvent,
      status: 'SOLD_OUT',
      available_spots: 0,
    });

    await expect(service.create(dto)).rejects.toThrow(new ConflictException('Event is sold out'));
    expect(eventsClient.reserveSpot).not.toHaveBeenCalled();
  });

  it('responde 409 para evento publicado sem vagas', async () => {
    const { service, eventsClient } = setup();
    eventsClient.getEventById.mockResolvedValue({ ...openEvent, available_spots: 0 });

    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('responde 409 para participante já inscrito sem reservar vaga', async () => {
    const { service, repository, eventsClient } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED));

    await expect(service.create(dto)).rejects.toThrow(
      new ConflictException('Participant already registered for this event'),
    );
    expect(eventsClient.reserveSpot).not.toHaveBeenCalled();
  });

  it('não salva o ingresso quando a reserva é recusada', async () => {
    const { service, repository, eventsClient } = setup();
    repository.findOne.mockResolvedValue(null);
    eventsClient.reserveSpot.mockRejectedValue(new ConflictException('Event is sold out'));

    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventsClient.releaseSpot).not.toHaveBeenCalled();
  });

  it('devolve a vaga e responde 500 quando o salvamento falha', async () => {
    const { service, repository, eventsClient, issued } = setup();
    repository.findOne.mockResolvedValue(null);
    repository.save.mockRejectedValue(new Error('database down'));

    await expect(service.create(dto)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(eventsClient.releaseSpot).toHaveBeenCalledWith(EVENT_ID);
    expect(issued).not.toHaveBeenCalled();
  });

  it('devolve a vaga e responde 409 em inscrição simultânea duplicada', async () => {
    const { service, repository, eventsClient } = setup();
    repository.findOne.mockResolvedValue(null);
    repository.save.mockRejectedValue(uniqueViolation(ACTIVE_PARTICIPANT_INDEX));

    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(eventsClient.releaseSpot).toHaveBeenCalledTimes(1);
  });

  it('gera outro código em caso de colisão, sem devolver a vaga', async () => {
    const { service, repository, eventsClient } = setup();
    repository.findOne.mockResolvedValue(null);
    repository.save.mockRejectedValueOnce(uniqueViolation('UQ_ticket_code'));

    await expect(service.create(dto)).resolves.toBeDefined();
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(eventsClient.releaseSpot).not.toHaveBeenCalled();
  });

  it('mantém o erro original mesmo se a compensação falhar', async () => {
    const { service, repository, eventsClient } = setup();
    repository.findOne.mockResolvedValue(null);
    repository.save.mockRejectedValue(new Error('database down'));
    eventsClient.releaseSpot.mockRejectedValue(new ServiceUnavailableException());

    await expect(service.create(dto)).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('TicketsService.findOne', () => {
  it('busca por id quando recebe um UUID', async () => {
    const { service, repository } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED));

    await service.findOne(TICKET_ID);

    expect(repository.findOne).toHaveBeenCalledWith({ where: { id: TICKET_ID } });
  });

  it('busca por ticket_code quando não recebe um UUID', async () => {
    const { service, repository } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED));

    await service.findOne('EVT-2026-A8F9K2');

    expect(repository.findOne).toHaveBeenCalledWith({
      where: { ticket_code: 'EVT-2026-A8F9K2' },
    });
  });

  it('responde 404 para ingresso inexistente', async () => {
    const { service, repository } = setup();
    repository.findOne.mockResolvedValue(null);

    await expect(service.findOne(TICKET_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TicketsService.update', () => {
  it('realiza o check-in de um ingresso confirmado', async () => {
    const { service, repository } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED));

    await service.update(TICKET_ID, { status: TicketStatus.CHECKED_IN });

    expect(repository.update).toHaveBeenCalledWith(
      { id: TICKET_ID, status: TicketStatus.CONFIRMED },
      { status: TicketStatus.CHECKED_IN },
    );
  });

  it('responde 409 em check-in repetido', async () => {
    const { service, repository } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CHECKED_IN));

    await expect(
      service.update(TICKET_ID, { status: TicketStatus.CHECKED_IN }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('responde 409 ao editar ingresso cancelado', async () => {
    const { service, repository } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CANCELLED));

    await expect(service.update(TICKET_ID, { participant_name: 'Ana' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('não grava nada quando o corpo está vazio', async () => {
    const { service, repository } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED));

    await service.update(TICKET_ID, {});

    expect(repository.update).not.toHaveBeenCalled();
  });

  it('responde 409 ao trocar para documento já inscrito no evento', async () => {
    const { service, repository } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED));
    repository.update.mockRejectedValue(uniqueViolation(ACTIVE_PARTICIPANT_INDEX));

    await expect(
      service.update(TICKET_ID, { participant_document: '999' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TicketsService.cancel', () => {
  it.each([TicketStatus.CONFIRMED, TicketStatus.CHECKED_IN])(
    'cancela ingresso %s e devolve a vaga',
    async (status) => {
      const { service, repository, eventsClient, cancelled } = setup();
      repository.findOne.mockResolvedValue(storedTicket(status));

      await service.cancel(TICKET_ID);

      expect(repository.update).toHaveBeenCalledWith(
        { id: TICKET_ID, status },
        { status: TicketStatus.CANCELLED },
      );
      expect(eventsClient.releaseSpot).toHaveBeenCalledWith(EVENT_ID);
      expect(cancelled).toHaveBeenCalledTimes(1);
    },
  );

  it('responde 409 e não devolve vaga se já estiver cancelado', async () => {
    const { service, repository, eventsClient } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CANCELLED));

    await expect(service.cancel(TICKET_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(eventsClient.releaseSpot).not.toHaveBeenCalled();
  });

  it('não devolve vaga quando perde a corrida para outro cancelamento', async () => {
    const { service, repository, eventsClient } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED));
    repository.update.mockResolvedValue({ affected: 0 });

    await expect(service.cancel(TICKET_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(eventsClient.releaseSpot).not.toHaveBeenCalled();
  });

  it('mantém o cancelamento se o evento não existir mais', async () => {
    const { service, repository, eventsClient, cancelled } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CONFIRMED));
    eventsClient.releaseSpot.mockRejectedValue(new NotFoundException('Event not found'));

    await expect(service.cancel(TICKET_ID)).resolves.toBeDefined();
    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('restaura o status anterior e responde 503 se o events-service falhar', async () => {
    const { service, repository, eventsClient, cancelled } = setup();
    repository.findOne.mockResolvedValue(storedTicket(TicketStatus.CHECKED_IN));
    eventsClient.releaseSpot.mockRejectedValue(new ServiceUnavailableException());

    await expect(service.cancel(TICKET_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.update).toHaveBeenLastCalledWith(
      { id: TICKET_ID, status: TicketStatus.CANCELLED },
      { status: TicketStatus.CHECKED_IN },
    );
    expect(cancelled).not.toHaveBeenCalled();
  });
});
