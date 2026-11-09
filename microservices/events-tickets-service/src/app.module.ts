import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmConfig } from './config/typeorm.config';
import { EventsModule } from './events/events.module';
import { MetricsModule } from './metrics/metrics.module';
import { OutboxModule } from './outbox/outbox.module';
import { TicketsModule } from './tickets/tickets.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: typeOrmConfig }),
    MetricsModule,
    EventsModule,
    TicketsModule,
    OutboxModule,
  ],
})
export class AppModule {}
