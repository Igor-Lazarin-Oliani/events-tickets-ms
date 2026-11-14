import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ClosedEvent, EventClosureReason } from './entities/closed-event.entity';

/** Único ponto de acesso à tabela closed_events. */
@Injectable()
export class ClosedEventsRepository {
  constructor(@InjectRepository(ClosedEvent) private readonly closed: Repository<ClosedEvent>) {}

  /**
   * Trava o evento até o fim da transação. A emissão e o cancelamento em cascata usam o mesmo
   * lock: um espera o outro, e nenhum ingresso é salvo entre o cancelamento e o registro do evento
   * como encerrado. É um lock consultivo porque o evento não tem linha neste banco.
   */
  async lock(manager: EntityManager, eventId: string): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [eventId]);
  }

  async isClosed(eventId: string, manager?: EntityManager): Promise<boolean> {
    const repository = manager ? manager.getRepository(ClosedEvent) : this.closed;
    return repository.exists({ where: { event_id: eventId } });
  }

  /** Registra o encerramento; repetir não muda nada, porque a entrega é "ao menos uma vez". */
  async markClosed(manager: EntityManager, eventId: string, reason: EventClosureReason): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(ClosedEvent)
      .values({ event_id: eventId, reason })
      .orIgnore()
      .execute();
  }
}
