import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LogsIntegrationModule } from '../logs-integration/logs-integration.module';
import { MetricsModule } from '../metrics/metrics.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [DatabaseModule, LogsIntegrationModule, MetricsModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
