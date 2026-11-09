import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Trim } from '../../common/validation';
import { EventModality } from '../entities/event.entity';

// Limite da coluna INTEGER do PostgreSQL.
export const MAX_CAPACITY_LIMIT = 2_147_483_647;

// Datas exigem fuso (Z ou ±hh:mm), para não serem gravadas no horário errado (D10).
export const WITH_TIMEZONE = /(Z|[+-]\d{2}:\d{2})$/i;
export const TIMEZONE_MESSAGE = '$property must include a timezone (Z or ±hh:mm)';

export class CreateEventDto {
  @ApiProperty({ example: 'Semana da Computação UFMS', maxLength: 200 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ example: 'Palestras e minicursos para a comunidade acadêmica.' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ example: 'ACADEMIC', default: 'GENERAL', maxLength: 50 })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  category?: string;

  @ApiProperty({ enum: EventModality, example: EventModality.IN_PERSON })
  @IsEnum(EventModality)
  modality: EventModality;

  @ApiProperty({ example: 'Auditório da FACOM, Campo Grande - MS', maxLength: 500 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  location: string;

  @ApiProperty({ description: 'Início, com fuso horário.', example: '2026-11-20T08:00:00-04:00' })
  @IsISO8601({ strict: true })
  @Matches(WITH_TIMEZONE, { message: TIMEZONE_MESSAGE })
  start_at: string;

  @ApiProperty({
    description: 'Fim, com fuso horário e posterior ao início.',
    example: '2026-11-20T18:00:00-04:00',
  })
  @IsISO8601({ strict: true })
  @Matches(WITH_TIMEZONE, { message: TIMEZONE_MESSAGE })
  end_at: string;

  @ApiProperty({ description: 'Capacidade total do evento.', example: 2, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_CAPACITY_LIMIT)
  max_capacity: number;

  @ApiPropertyOptional({
    description: 'Atributos livres do evento.',
    example: { palestrante: 'Profa. Ana Souza', carga_horaria: 10 },
  })
  @IsOptional()
  @IsObject()
  metadata_info?: Record<string, unknown> | null;
}
