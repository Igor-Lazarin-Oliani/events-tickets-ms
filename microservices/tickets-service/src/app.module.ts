import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmConfig } from './config/typeorm.config';
import { MetricsModule } from './metrics/metrics.module';
import { TicketsModule } from './tickets/tickets.module';

@Module({
  imports: [TypeOrmModule.forRootAsync({ useFactory: typeOrmConfig }), MetricsModule, TicketsModule],
})
export class AppModule {}
