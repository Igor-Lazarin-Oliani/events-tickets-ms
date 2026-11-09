import { TypeOrmModuleOptions } from '@nestjs/typeorm';

const DEFAULT_DATABASE_URL =
  'postgresql://events_tickets_user:events_tickets_pass@events-tickets-db:5432/events_tickets_db';

export function typeOrmConfig(): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    autoLoadEntities: true,
    synchronize: true,
    // Tolera o intervalo em que o PostgreSQL ainda recusa conexões na subida.
    retryAttempts: 30,
    retryDelay: 1000,
  };
}
