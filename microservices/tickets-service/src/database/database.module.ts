import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxMessage } from '../outbox/entities/outbox-message.entity';
import { OutboxRepository } from '../outbox/outbox.repository';
import { ClosedEventsRepository } from '../tickets/closed-events.repository';
import { ClosedEvent } from '../tickets/entities/closed-event.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketsRepository } from '../tickets/tickets.repository';

/**
 * Repositórios das três tabelas do tickets_db. Ficam em um módulo próprio porque os ingressos, os
 * eventos encerrados e a outbox mudam juntos na mesma transação.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Ticket, ClosedEvent, OutboxMessage])],
  providers: [TicketsRepository, ClosedEventsRepository, OutboxRepository],
  exports: [TicketsRepository, ClosedEventsRepository, OutboxRepository],
})
export class DatabaseModule {}
