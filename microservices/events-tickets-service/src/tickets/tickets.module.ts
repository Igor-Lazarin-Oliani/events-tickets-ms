import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LogsIntegrationModule } from '../logs-integration/logs-integration.module';
import { MetricsModule } from '../metrics/metrics.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [DatabaseModule, LogsIntegrationModule, MetricsModule],
  controllers: [TicketsController],
  providers: [TicketsService],
})
export class TicketsModule {}
