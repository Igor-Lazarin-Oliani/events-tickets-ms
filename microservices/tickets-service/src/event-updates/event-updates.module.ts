import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module';
import { TicketsModule } from '../tickets/tickets.module';
import { EventUpdatesConsumer } from './event-updates.consumer';

@Module({
  imports: [TicketsModule, MetricsModule],
  providers: [EventUpdatesConsumer],
})
export class EventUpdatesModule {}
