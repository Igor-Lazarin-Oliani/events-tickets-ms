import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const EVENT_NOT_FOUND = 'Event not found';

export enum EventModality {
  IN_PERSON = 'IN_PERSON',
  ONLINE = 'ONLINE',
  HYBRID = 'HYBRID',
}

export enum EventStatus {
  PUBLISHED = 'PUBLISHED',
  SOLD_OUT = 'SOLD_OUT',
  CANCELLED = 'CANCELLED',
  FINISHED = 'FINISHED',
}

@Entity('events')
@Check('ck_events_max_capacity_positive', '"max_capacity" > 0')
@Check(
  'ck_events_available_spots_range',
  '"available_spots" >= 0 AND "available_spots" <= "max_capacity"',
)
export class Event {
  @ApiProperty({ format: 'uuid', example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ example: 'Semana da Computação UFMS', maxLength: 200 })
  @Column({ length: 200 })
  title: string;

  @ApiPropertyOptional({
    example: 'Palestras e minicursos para a comunidade acadêmica.',
    nullable: true,
  })
  @Column({ type: 'text', nullable: true })
  description: string | null;

  @ApiProperty({ example: 'ACADEMIC', maxLength: 50 })
  @Index()
  @Column({ length: 50 })
  category: string;

  @ApiProperty({ enum: EventModality, example: EventModality.IN_PERSON })
  @Column({ type: 'varchar', length: 20 })
  modality: EventModality;

  @ApiProperty({ example: 'Auditório da FACOM, Campo Grande - MS', maxLength: 500 })
  @Column({ length: 500 })
  location: string;

  @ApiProperty({ example: '2027-03-20T12:00:00.000Z' })
  @Column({ type: 'timestamptz' })
  start_at: Date;

  @ApiProperty({ example: '2027-03-20T22:00:00.000Z' })
  @Column({ type: 'timestamptz' })
  end_at: Date;

  @ApiProperty({ example: 2 })
  @Column('int')
  max_capacity: number;

  @ApiProperty({
    description:
      'Vagas livres. Só a emissão e o cancelamento de ingressos e a alteração de capacidade mudam este valor.',
    example: 2,
  })
  @Column('int')
  available_spots: number;

  @ApiProperty({ enum: EventStatus, example: EventStatus.PUBLISHED })
  @Index()
  @Column({ type: 'varchar', length: 20, default: EventStatus.PUBLISHED })
  status: EventStatus;

  @ApiPropertyOptional({
    description: 'Atributos livres, como palestrante, carga horária ou classificação.',
    example: { palestrante: 'Profa. Ana Souza', carga_horaria: 10 },
    nullable: true,
  })
  @Column({ type: 'jsonb', nullable: true })
  metadata_info: Record<string, unknown> | null;

  @ApiProperty({ example: '2026-11-08T20:00:00.000Z' })
  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @ApiProperty({ example: '2026-11-08T20:00:00.000Z' })
  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
