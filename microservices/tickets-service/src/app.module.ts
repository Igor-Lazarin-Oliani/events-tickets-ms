import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmConfig } from './config/typeorm.config';
import { EventsMessagingModule } from './events-messaging/events-messaging.module';
import { MetricsModule } from './metrics/metrics.module';
import { TicketsModule } from './tickets/tickets.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: typeOrmConfig }),
    MetricsModule,
    TicketsModule,
    EventsMessagingModule,
  ],
})
export class AppModule {}
