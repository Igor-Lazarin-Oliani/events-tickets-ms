import { IsEmail, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { TicketStatus } from '../entities/ticket.entity';

export class ListTicketsQueryDto {
  @IsOptional()
  @IsUUID()
  event_id?: string;

  @IsOptional()
  @IsEmail()
  participant_email?: string;

  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;
}
