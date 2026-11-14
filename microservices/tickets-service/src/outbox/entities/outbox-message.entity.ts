import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { OutboxPayload } from '../activity';

/** Mensagem gravada na mesma transação da mudança e publicada depois no RabbitMQ (D16, D20). */
@Entity('outbox_messages')
export class OutboxMessage {
  // Igual ao message_id do corpo, que os consumidores usam para descartar repetições.
  @PrimaryColumn('uuid')
  id: string;

  @Column({ length: 100 })
  exchange: string;

  @Column({ length: 100 })
  routing_key: string;

  @Column({ type: 'jsonb' })
  payload: OutboxPayload;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  published_at: Date | null;
}
