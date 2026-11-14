import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsIntegrationModule } from '../events-integration/events-integration.module';
import { LogsIntegrationModule } from '../logs-integration/logs-integration.module';
import { MetricsModule } from '../metrics/metrics.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [DatabaseModule, EventsIntegrationModule, LogsIntegrationModule, MetricsModule],
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
