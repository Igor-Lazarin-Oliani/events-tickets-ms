import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { randomInt } from 'node:crypto';
import { EntityManager, FindOptionsWhere, Not, Repository } from 'typeorm';
import { uniqueViolationConstraint } from '../common/postgres-errors';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { ACTIVE_PARTICIPANT_INDEX, Ticket, TicketStatus } from './entities/ticket.entity';

const TICKET_CODE_PREFIX = 'EVT-2026-';
const TICKET_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TICKET_CODE_SUFFIX_LENGTH = 6;
const MAX_TICKET_CODE_ATTEMPTS = 5;

export type NewTicket = Omit<Ticket, 'id' | 'ticket_code' | 'created_at' | 'updated_at'>;
export type CancelledTicketRef = Pick<Ticket, 'id' | 'ticket_code'>;

export function generateTicketCode(): string {
  let suffix = '';
  for (let index = 0; index < TICKET_CODE_SUFFIX_LENGTH; index += 1) {
    suffix += TICKET_CODE_ALPHABET[randomInt(TICKET_CODE_ALPHABET.length)];
  }
  return `${TICKET_CODE_PREFIX}${suffix}`;
}

/** Único ponto de acesso à tabela tickets. Recebe o EntityManager da transação em curso. */
@Injectable()
export class TicketsRepository {
  constructor(@InjectRepository(Ticket) private readonly tickets: Repository<Ticket>) {}

  findAll(query: ListTicketsQueryDto): Promise<Ticket[]> {
    const where: FindOptionsWhere<Ticket> = {};
    if (query.event_id) where.event_id = query.event_id;
    if (query.participant_email) where.participant_email = query.participant_email;
    if (query.status) where.status = query.status;
    return this.tickets.find({ where, order: { created_at: 'DESC' } });
  }

  /** Aceita o UUID ou o ticket_code. */
  findByIdOrCode(idOrCode: string): Promise<Ticket | null> {
    const where = isUUID(idOrCode) ? { id: idOrCode } : { ticket_code: idOrCode };
    return this.tickets.findOne({ where });
  }

  findActiveRegistration(eventId: string, participantDocument: string): Promise<Ticket | null> {
    return this.tickets.findOne({
      where: {
        event_id: eventId,
        participant_document: participantDocument,
        status: Not(TicketStatus.CANCELLED),
      },
    });
  }

  /**
   * Salva com um código novo a cada colisão. Cada tentativa roda em um savepoint, porque um erro
   * dentro da transação do PostgreSQL invalidaria a reserva de vaga já feita.
   */
  async insertWithUniqueCode(manager: EntityManager, data: NewTicket): Promise<Ticket> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await manager.transaction((savepoint) => {
          const repository = savepoint.getRepository(Ticket);
          return repository.save(repository.create({ ...data, ticket_code: generateTicketCode() }));
        });
      } catch (error) {
        const constraint = uniqueViolationConstraint(error);
        const isCodeCollision = constraint !== undefined && constraint !== ACTIVE_PARTICIPANT_INDEX;
        if (!isCodeCollision || attempt === MAX_TICKET_CODE_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  /** Atualiza só se o status não mudou desde a leitura; false se outra requisição chegou antes. */
  async updateIfStatus(
    manager: EntityManager,
    id: string,
    expectedStatus: TicketStatus,
    changes: Partial<Ticket>,
  ): Promise<boolean> {
    const result = await manager
      .getRepository(Ticket)
      .update({ id, status: expectedStatus }, changes);
    return Boolean(result.affected);
  }

  /** Cancela de uma vez os ingressos ativos do evento e devolve quais foram cancelados. */
  async cancelActiveForEvent(manager: EntityManager, eventId: string): Promise<CancelledTicketRef[]> {
    const result = await manager
      .createQueryBuilder()
      .update(Ticket)
      .set({ status: TicketStatus.CANCELLED })
      .where('"event_id" = :eventId AND "status" <> :cancelled', {
        eventId,
        cancelled: TicketStatus.CANCELLED,
      })
      .returning(['id', 'ticket_code'])
      .execute();
    return (result.raw as CancelledTicketRef[]) ?? [];
  }
}
