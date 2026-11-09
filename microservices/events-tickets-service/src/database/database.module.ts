import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event } from '../events/entities/event.entity';
import { EventsRepository } from '../events/events.repository';
import { OutboxMessage } from '../outbox/entities/outbox-message.entity';
import { OutboxRepository } from '../outbox/outbox.repository';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketsRepository } from '../tickets/tickets.repository';

/**
 * Repositórios das três tabelas do events_tickets_db. Ficam em um módulo próprio porque eventos e
 * ingressos mudam juntos na mesma transação, e um importar o outro criaria dependência circular.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Event, Ticket, OutboxMessage])],
  providers: [EventsRepository, TicketsRepository, OutboxRepository],
  exports: [EventsRepository, TicketsRepository, OutboxRepository],
})
export class DatabaseModule {}
