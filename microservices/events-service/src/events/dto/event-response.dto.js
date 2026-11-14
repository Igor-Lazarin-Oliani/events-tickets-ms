import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EventModality, EventStatus } from '../entities/event.entity';

/** Formato de um evento nas respostas. Só documenta o Swagger: a tabela é o EventEntity. */
export class EventResponseDto {
  @ApiProperty({ type: String, format: 'uuid', example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id;

  @ApiProperty({ type: String, example: 'Semana da Computação UFMS', maxLength: 200 })
  title;

  @ApiPropertyOptional({
    type: String,
    example: 'Palestras e minicursos para a comunidade acadêmica.',
    nullable: true,
  })
  description;

  @ApiProperty({ type: String, example: 'ACADEMIC', maxLength: 50 })
  category;

  @ApiProperty({ enum: EventModality, example: EventModality.IN_PERSON })
  modality;

  @ApiProperty({ type: String, example: 'Auditório da FACOM, Campo Grande - MS', maxLength: 500 })
  location;

  @ApiProperty({ type: String, format: 'date-time', example: '2027-03-20T12:00:00.000Z' })
  start_at;

  @ApiProperty({ type: String, format: 'date-time', example: '2027-03-20T22:00:00.000Z' })
  end_at;

  @ApiProperty({ type: Number, example: 2 })
  max_capacity;

  @ApiProperty({
    type: Number,
    description:
      'Vagas livres. Só a reserva e a devolução de vagas pedidas pelo tickets-service e a alteração de capacidade mudam este valor.',
    example: 2,
  })
  available_spots;

  @ApiProperty({ enum: EventStatus, example: EventStatus.PUBLISHED })
  status;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Atributos livres, como palestrante, carga horária ou classificação.',
    example: { palestrante: 'Profa. Ana Souza', carga_horaria: 10 },
    nullable: true,
  })
  metadata_info;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-08T20:00:00.000Z' })
  created_at;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-08T20:00:00.000Z' })
  updated_at;
}
