import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { TicketStatus } from '../entities/ticket.entity';
import { Trim } from './create-ticket.dto';

// Diferente de @IsOptional, recusa null, pois todas as colunas editáveis são obrigatórias.
const IfPresent = () => ValidateIf((_, value: unknown) => value !== undefined);

export class UpdateTicketDto {
  @ApiPropertyOptional({ example: 'Maria Souza Silva', maxLength: 200 })
  @IfPresent()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  participant_name?: string;

  @ApiPropertyOptional({ example: 'maria.souza@example.com' })
  @IfPresent()
  @IsEmail()
  participant_email?: string;

  @ApiPropertyOptional({ example: '2026654321', maxLength: 50 })
  @IfPresent()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  participant_document?: string;

  @ApiPropertyOptional({ example: 'VIP', maxLength: 50 })
  @IfPresent()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  modality_tier?: string;

  @ApiPropertyOptional({
    description: 'Envie CHECKED_IN para registrar a presença. Para cancelar, use o DELETE.',
    enum: [TicketStatus.CHECKED_IN],
    example: TicketStatus.CHECKED_IN,
  })
  @IfPresent()
  @IsIn([TicketStatus.CHECKED_IN])
  status?: TicketStatus.CHECKED_IN;
}
