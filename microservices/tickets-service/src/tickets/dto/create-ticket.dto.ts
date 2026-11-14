import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Trim } from '../../common/validation';

export class CreateTicketDto {
  @ApiProperty({
    description: 'UUID do evento.',
    format: 'uuid',
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  })
  @IsUUID()
  event_id: string;

  @ApiProperty({ description: 'Nome do participante.', example: 'Maria Silva', maxLength: 200 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  participant_name: string;

  @ApiProperty({ description: 'E-mail do participante.', example: 'maria.silva@example.com' })
  @IsEmail()
  participant_email: string;

  @ApiProperty({ description: 'CPF, RG ou matrícula.', example: '2026123456', maxLength: 50 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  participant_document: string;

  @ApiPropertyOptional({
    description: 'Categoria da inscrição, como VIP, ESTUDANTE, OUVINTE ou LOTE_1.',
    example: 'ESTUDANTE',
    default: 'STANDARD',
    maxLength: 50,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  modality_tier?: string;
}
