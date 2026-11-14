const DEFAULT_DATABASE_URL = 'postgresql://events_user:events_pass@events-db:5432/events_db';

export function typeOrmConfig() {
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
