import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmConfig } from './config/typeorm.config';
import { EventsModule } from './events/events.module';
import { MetricsModule } from './metrics/metrics.module';
import { OutboxModule } from './outbox/outbox.module';
import { SpotReleasesModule } from './spot-releases/spot-releases.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: typeOrmConfig }),
    MetricsModule,
    EventsModule,
    SpotReleasesModule,
    OutboxModule,
  ],
})
export class AppModule {}
