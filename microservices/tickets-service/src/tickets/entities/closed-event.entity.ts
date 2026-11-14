import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type EventClosureReason = 'event_cancelled' | 'event_deleted';

/**
 * Evento que o events-service cancelou ou removeu, conhecido pela mensagem do RabbitMQ (D32).
 * Barra inscrições novas e fecha a corrida entre uma emissão em andamento e o cancelamento em
 * cascata dos ingressos.
 */
@Entity('closed_events')
export class ClosedEvent {
  @PrimaryColumn('uuid')
  event_id: string;

  @Column({ type: 'varchar', length: 30 })
  reason: EventClosureReason;

  @CreateDateColumn({ type: 'timestamptz' })
  closed_at: Date;
}
