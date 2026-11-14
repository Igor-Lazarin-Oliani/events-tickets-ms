import { EntitySchema } from 'typeorm';

/** Mensagem gravada na mesma transação da mudança e publicada depois no RabbitMQ (D16, D20). */
export const OutboxMessageEntity = new EntitySchema({
  name: 'OutboxMessage',
  tableName: 'outbox_messages',
  columns: {
    // Igual ao message_id do corpo, que os consumidores usam para descartar repetições.
    id: { type: 'uuid', primary: true },
    exchange: { type: 'varchar', length: 100 },
    routing_key: { type: 'varchar', length: 100 },
    payload: { type: 'jsonb' },
    created_at: { type: 'timestamptz', createDate: true },
    published_at: { type: 'timestamptz', nullable: true },
  },
  indices: [{ name: 'ix_outbox_messages_published_at', columns: ['published_at'] }],
});
