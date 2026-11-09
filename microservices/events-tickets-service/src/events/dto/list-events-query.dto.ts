import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { EventStatus } from '../entities/event.entity';

export class ListEventsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;
}
