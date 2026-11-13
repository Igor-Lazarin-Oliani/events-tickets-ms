import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, Repository, UpdateResult } from 'typeorm';
import { Page, PageRequest } from '../common/pagination';
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

  /** Página de eventos, dos mais recentes aos mais antigos, com o total que atende aos filtros. */
  async findAll(filters: EventFilters, page: PageRequest): Promise<Page<Event>> {
    const where: FindOptionsWhere<Event> = {};
    if (filters.category) where.category = filters.category;
    if (filters.status) where.status = filters.status;
    const [items, total] = await this.events.findAndCount({
      where,
      // O id desempata eventos criados no mesmo instante, para as páginas não repetirem itens.
      order: { created_at: 'DESC', id: 'DESC' },
      take: page.limit,
      skip: page.offset,
    });
    return { items, total };
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

  /**
   * Reserva em um único UPDATE condicional; null se o evento não tiver vaga, estiver fechado ou já
   * tiver terminado. O RETURNING devolve a linha atualizada sem outra consulta enquanto o lock da
   * linha está retido, o que encurta a espera das reservas concorrentes no mesmo evento.
   */
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
      .where(
        '"id" = :id AND "status" = :status AND "available_spots" > 0 AND "end_at" > now()',
        { id, status: EventStatus.PUBLISHED },
      )
      .returning('*')
      .execute();
    return this.updatedRow(manager, result);
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
      .returning('*')
      .execute();
    return this.updatedRow(manager, result);
  }

  /** Converte a linha do RETURNING em entidade; as colunas têm o mesmo nome das propriedades. */
  private updatedRow(manager: EntityManager, result: UpdateResult): Event | null {
    const [row] = (result.raw ?? []) as Partial<Event>[];
    return row ? manager.create(Event, row) : null;
  }
}
