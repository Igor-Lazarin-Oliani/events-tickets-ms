import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { MetricsModule } from '../metrics/metrics.module';
import { SpotReleasesConsumer } from './spot-releases.consumer';

@Module({
  imports: [EventsModule, MetricsModule],
  providers: [SpotReleasesConsumer],
})
export class SpotReleasesModule {}
