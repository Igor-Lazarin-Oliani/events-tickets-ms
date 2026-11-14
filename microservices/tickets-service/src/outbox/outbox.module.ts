import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MetricsModule } from '../metrics/metrics.module';
import { OutboxPublisher } from './outbox.publisher';

@Module({
  imports: [DatabaseModule, MetricsModule],
  providers: [OutboxPublisher],
})
export class OutboxModule {}
