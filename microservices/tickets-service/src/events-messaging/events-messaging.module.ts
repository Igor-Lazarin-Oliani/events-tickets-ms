import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module';
import { TicketsModule } from '../tickets/tickets.module';
import { EventMessagesConsumer } from './event-messages.consumer';

@Module({
  imports: [TicketsModule, MetricsModule],
  providers: [EventMessagesConsumer],
})
export class EventsMessagingModule {}
