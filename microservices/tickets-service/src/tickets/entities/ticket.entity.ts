import { ApiProperty } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export enum TicketStatus {
  CONFIRMED = 'CONFIRMED',
  CHECKED_IN = 'CHECKED_IN',
  CANCELLED = 'CANCELLED',
}

export const ACTIVE_PARTICIPANT_INDEX = 'uq_tickets_active_event_participant';

export class EventSnapshot {
  @ApiProperty({ example: 'Semana da Computação UFMS' })
  title: string;

  @ApiProperty({ example: 'ACADEMIC' })
  category: string;

  @ApiProperty({ example: 'IN_PERSON' })
  modality: string;

  @ApiProperty({ example: 'Auditório da FACOM, Campo Grande - MS' })
  location: string;

  @ApiProperty({ example: '2027-03-20T12:00:00Z' })
  start_at: string;
}

@Entity('tickets')
// Garante a regra de inscrição única mesmo com requisições simultâneas.
@Index(ACTIVE_PARTICIPANT_INDEX, ['event_id', 'participant_document'], {
  unique: true,
  where: `"status" <> 'CANCELLED'`,
})
export class Ticket {
  @ApiProperty({
    description:
      'Gerado pelo tickets-service antes da reserva: é a chave que o events-service usa para reservar e ' +
      'devolver a vaga uma única vez.',
    format: 'uuid',
    example: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  })
  @PrimaryColumn('uuid')
  id: string;

  @ApiProperty({ description: 'Código único do ingresso.', example: 'EVT-2026-A8F9K2' })
  @Column({ unique: true })
  ticket_code: string;

  @ApiProperty({
    description:
      'Evento do events-service. Não há chave estrangeira entre bancos: o ingresso continua existindo se o evento for removido.',
    format: 'uuid',
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  })
  @Column('uuid')
  event_id: string;

  @ApiProperty({
    description: 'Dados do evento no momento da inscrição; preservam o histórico se o evento sair.',
    type: EventSnapshot,
  })
  @Column({ type: 'jsonb' })
  event_snapshot: EventSnapshot;

  @ApiProperty({ example: 'Maria Silva' })
  @Column()
  participant_name: string;

  @ApiProperty({ example: 'maria.silva@example.com' })
  @Column()
  participant_email: string;

  @ApiProperty({ description: 'CPF, RG ou matrícula.', example: '2026123456' })
  @Column()
  participant_document: string;

  @ApiProperty({ example: 'ESTUDANTE', default: 'STANDARD' })
  @Column({ default: 'STANDARD' })
  modality_tier: string;

  @ApiProperty({ enum: TicketStatus, example: TicketStatus.CONFIRMED })
  @Column({ type: 'varchar', default: TicketStatus.CONFIRMED })
  status: TicketStatus;

  @ApiProperty({ example: '2026-11-08T20:00:00.000Z' })
  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @ApiProperty({ example: '2026-11-08T20:00:00.000Z' })
  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
