import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEntity } from '../events/entities/event.entity';
import { SpotReservationEntity } from '../events/entities/spot-reservation.entity';
import { EventsRepository } from '../events/events.repository';
import { ReservationsRepository } from '../events/reservations.repository';
import { OutboxMessageEntity } from '../outbox/entities/outbox-message.entity';
import { OutboxRepository } from '../outbox/outbox.repository';

/**
 * Repositórios das três tabelas do events_db. Ficam em um módulo próprio porque eventos, reservas
 * e outbox mudam juntos na mesma transação.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EventEntity, SpotReservationEntity, OutboxMessageEntity])],
  providers: [EventsRepository, ReservationsRepository, OutboxRepository],
  exports: [EventsRepository, ReservationsRepository, OutboxRepository],
})
export class DatabaseModule {}
