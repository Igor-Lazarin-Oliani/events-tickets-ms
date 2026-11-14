import { Dependencies, Injectable } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ReservationStatus, SpotReservationEntity } from './entities/spot-reservation.entity';

/** Único ponto de acesso à tabela spot_reservations. */
@Injectable()
@Dependencies(getRepositoryToken(SpotReservationEntity))
export class ReservationsRepository {
  constructor(reservations) {
    this.reservations = reservations;
  }

  findByTicketId(ticketId, manager) {
    const repository = manager ? manager.getRepository(SpotReservationEntity) : this.reservations;
    return repository.findOneBy({ ticket_id: ticketId });
  }

  /** Trava a reserva até o fim da transação, para duas devoluções não a aplicarem juntas. */
  findByTicketIdForUpdate(manager, ticketId) {
    return manager
      .getRepository(SpotReservationEntity)
      .findOne({ where: { ticket_id: ticketId }, lock: { mode: 'pessimistic_write' } });
  }

  /** Insere a reserva; a chave primária ticket_id barra uma segunda linha para o mesmo ingresso. */
  insert(manager, data) {
    return manager.getRepository(SpotReservationEntity).insert(data);
  }

  async markReleased(manager, ticketId) {
    await manager
      .getRepository(SpotReservationEntity)
      .update(
        { ticket_id: ticketId, status: ReservationStatus.RESERVED },
        { status: ReservationStatus.RELEASED, released_at: new Date() },
      );
  }
}
