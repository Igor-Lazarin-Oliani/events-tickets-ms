import { EntitySchema } from 'typeorm';

export const EVENT_NOT_FOUND = 'Event not found';

export const EventModality = Object.freeze({
  IN_PERSON: 'IN_PERSON',
  ONLINE: 'ONLINE',
  HYBRID: 'HYBRID',
});

export const EventStatus = Object.freeze({
  PUBLISHED: 'PUBLISHED',
  SOLD_OUT: 'SOLD_OUT',
  CANCELLED: 'CANCELLED',
  FINISHED: 'FINISHED',
});

/**
 * Tabela events. Em JavaScript o TypeORM descreve a tabela com EntitySchema, sem decorators nem
 * tipos inferidos, e as linhas são objetos simples (D35).
 */
export const EventEntity = new EntitySchema({
  name: 'Event',
  tableName: 'events',
  columns: {
    id: { type: 'uuid', primary: true, generated: 'uuid' },
    title: { type: 'varchar', length: 200 },
    description: { type: 'text', nullable: true },
    category: { type: 'varchar', length: 50 },
    modality: { type: 'varchar', length: 20 },
    location: { type: 'varchar', length: 500 },
    start_at: { type: 'timestamptz' },
    end_at: { type: 'timestamptz' },
    max_capacity: { type: 'int' },
    // Só a reserva, a devolução e a alteração de capacidade mudam este valor.
    available_spots: { type: 'int' },
    status: { type: 'varchar', length: 20, default: EventStatus.PUBLISHED },
    metadata_info: { type: 'jsonb', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
  },
  indices: [
    { name: 'ix_events_category', columns: ['category'] },
    { name: 'ix_events_status', columns: ['status'] },
  ],
  checks: [
    { name: 'ck_events_max_capacity_positive', expression: '"max_capacity" > 0' },
    {
      name: 'ck_events_available_spots_range',
      expression: '"available_spots" >= 0 AND "available_spots" <= "max_capacity"',
    },
  ],
});
