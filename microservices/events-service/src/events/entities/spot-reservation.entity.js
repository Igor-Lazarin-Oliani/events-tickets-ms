import { EntitySchema } from 'typeorm';

export const ReservationStatus = Object.freeze({
  RESERVED: 'RESERVED',
  RELEASED: 'RELEASED',
});

/**
 * Uma vaga por ingresso, identificada pelo ticket_id que o tickets-service gera antes de reservar
 * (D30). É o que torna a reserva e a devolução idempotentes: repetir a reserva devolve a mesma
 * vaga, e uma devolução repetida, ou de uma reserva que nunca aconteceu, não mexe nas vagas.
 * Uma devolução que chega antes da reserva deixa a linha RELEASED, e a reserva atrasada é recusada.
 */
export const SpotReservationEntity = new EntitySchema({
  name: 'SpotReservation',
  tableName: 'spot_reservations',
  columns: {
    ticket_id: { type: 'uuid', primary: true },
    // Sem chave estrangeira: a reserva continua como registro se o evento for removido.
    event_id: { type: 'uuid' },
    status: { type: 'varchar', length: 20 },
    reserved_at: { type: 'timestamptz', nullable: true },
    released_at: { type: 'timestamptz', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
  },
  indices: [{ name: 'ix_spot_reservations_event', columns: ['event_id'] }],
});
