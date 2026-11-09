import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, Repository } from 'typeorm';
import { Event, EventStatus } from './entities/event.entity';

export interface EventFilters {
  category?: string;
  status?: EventStatus;
}

/** Único ponto de acesso à tabela events. Recebe o EntityManager da transação em curso. */
@Injectable()
export class EventsRepository {
  constructor(@InjectRepository(Event) private readonly events: Repository<Event>) {}

  create(manager: EntityManager, data: Partial<Event>): Promise<Event> {
    const repository = manager.getRepository(Event);
    return repository.save(repository.create(data));
  }

  findAll(filters: EventFilters): Promise<Event[]> {
    const where: FindOptionsWhere<Event> = {};
    if (filters.category) where.category = filters.category;
    if (filters.status) where.status = filters.status;
    return this.events.find({ where, order: { created_at: 'DESC' } });
  }

  findById(id: string, manager?: EntityManager): Promise<Event | null> {
    const repository = manager ? manager.getRepository(Event) : this.events;
    return repository.findOneBy({ id });
  }

  /** Trava a linha até o fim da transação, para não concorrer com reservas de vaga. */
  findByIdForUpdate(manager: EntityManager, id: string): Promise<Event | null> {
    return manager
      .getRepository(Event)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }

  save(manager: EntityManager, event: Event): Promise<Event> {
    return manager.getRepository(Event).save(event);
  }

  async delete(manager: EntityManager, id: string): Promise<boolean> {
    const result = await manager.getRepository(Event).delete({ id });
    return Boolean(result.affected);
  }

  /** Reserva em um único UPDATE condicional; null se o evento não tiver vaga ou estiver fechado. */
  async reserveSpot(manager: EntityManager, id: string): Promise<Event | null> {
    const result = await manager
      .createQueryBuilder()
      .update(Event)
      .set({
        available_spots: () => '"available_spots" - 1',
        // No SET, available_spots ainda é o valor anterior ao decremento.
        status: () =>
          `CASE WHEN "available_spots" = 1 THEN '${EventStatus.SOLD_OUT}' ELSE "status" END`,
      })
      .where('"id" = :id AND "status" = :status AND "available_spots" > 0', {
        id,
        status: EventStatus.PUBLISHED,
      })
      .execute();
    return result.affected ? this.findById(id, manager) : null;
  }

  /** Devolve em um único UPDATE condicional; null se o evento não existir ou já estiver cheio. */
  async releaseSpot(manager: EntityManager, id: string): Promise<Event | null> {
    const result = await manager
      .createQueryBuilder()
      .update(Event)
      .set({
        available_spots: () => '"available_spots" + 1',
        status: () =>
          `CASE WHEN "status" = '${EventStatus.SOLD_OUT}' THEN '${EventStatus.PUBLISHED}' ELSE "status" END`,
      })
      .where('"id" = :id AND "available_spots" < "max_capacity"', { id })
      .execute();
    return result.affected ? this.findById(id, manager) : null;
  }
}
