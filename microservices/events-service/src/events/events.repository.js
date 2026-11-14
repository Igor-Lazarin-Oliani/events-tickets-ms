import { Dependencies, Injectable } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEntity, EventStatus } from './entities/event.entity';

/** Único ponto de acesso à tabela events. Recebe o EntityManager da transação em curso. */
@Injectable()
@Dependencies(getRepositoryToken(EventEntity))
export class EventsRepository {
  constructor(events) {
    this.events = events;
  }

  create(manager, data) {
    const repository = manager.getRepository(EventEntity);
    return repository.save(repository.create(data));
  }

  /** Página de eventos, dos mais recentes aos mais antigos: { items, total }. */
  async findAll(filters, page) {
    const where = {};
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

  findById(id, manager) {
    const repository = manager ? manager.getRepository(EventEntity) : this.events;
    return repository.findOneBy({ id });
  }

  /** Trava a linha até o fim da transação, para não concorrer com reservas de vaga. */
  findByIdForUpdate(manager, id) {
    return manager
      .getRepository(EventEntity)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }

  save(manager, event) {
    return manager.getRepository(EventEntity).save(event);
  }

  async delete(manager, id) {
    const result = await manager.getRepository(EventEntity).delete({ id });
    return Boolean(result.affected);
  }

  /**
   * Reserva em um único UPDATE condicional; null se o evento não tiver vaga, estiver fechado ou já
   * tiver terminado. O RETURNING devolve a linha atualizada sem outra consulta enquanto o lock da
   * linha está retido, o que encurta a espera das reservas concorrentes no mesmo evento.
   */
  async reserveSpot(manager, id) {
    const result = await manager
      .createQueryBuilder()
      .update(EventEntity)
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
  async releaseSpot(manager, id) {
    const result = await manager
      .createQueryBuilder()
      .update(EventEntity)
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
  updatedRow(manager, result) {
    const [row] = result.raw ?? [];
    return row ? manager.create(EventEntity, row) : null;
  }
}
