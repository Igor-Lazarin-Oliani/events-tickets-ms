import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { IfPresent, Trim } from '../../common/validation';
import { EventModality, EventStatus } from '../entities/event.entity';
import { MAX_CAPACITY_LIMIT, TIMEZONE_MESSAGE, WITH_TIMEZONE } from './create-event.dto';

/** Atualização parcial: só os campos enviados mudam, e null só vale nas colunas opcionais. */
export class UpdateEventDto {
  @ApiPropertyOptional({ example: 'Semana da Computação UFMS 2026', maxLength: 200 })
  @IfPresent()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: 'Aceita null para apagar.', nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ example: 'ACADEMIC', maxLength: 50 })
  @IfPresent()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({ enum: EventModality })
  @IfPresent()
  @IsEnum(EventModality)
  modality?: EventModality;

  @ApiPropertyOptional({ example: 'Anfiteatro da UFMS, Campo Grande - MS', maxLength: 500 })
  @IfPresent()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional({ example: '2026-11-21T08:00:00-04:00' })
  @IfPresent()
  @IsISO8601({ strict: true })
  @Matches(WITH_TIMEZONE, { message: TIMEZONE_MESSAGE })
  start_at?: string;

  @ApiPropertyOptional({ example: '2026-11-21T18:00:00-04:00' })
  @IfPresent()
  @IsISO8601({ strict: true })
  @Matches(WITH_TIMEZONE, { message: TIMEZONE_MESSAGE })
  end_at?: string;

  @ApiPropertyOptional({
    description: 'As vagas ocupadas são preservadas; abaixo delas, responde 409.',
    example: 150,
    minimum: 1,
  })
  @IfPresent()
  @IsInt()
  @Min(1)
  @Max(MAX_CAPACITY_LIMIT)
  max_capacity?: number;

  @ApiPropertyOptional({
    description:
      'CANCELLED cancela os ingressos ativos na mesma transação e não pode ser desfeito.',
    enum: EventStatus,
    example: EventStatus.PUBLISHED,
  })
  @IfPresent()
  @IsEnum(EventStatus)
  status?: EventStatus;

  @ApiPropertyOptional({ description: 'Aceita null para apagar.', nullable: true })
  @IsOptional()
  @IsObject()
  metadata_info?: Record<string, unknown> | null;
}
