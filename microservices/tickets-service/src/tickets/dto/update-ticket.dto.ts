import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IfPresent, Trim } from '../../common/validation';
import { TicketStatus } from '../entities/ticket.entity';

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
