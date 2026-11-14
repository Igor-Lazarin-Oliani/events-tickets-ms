import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';
import { EventStatus } from '../entities/event.entity';

export class ListEventsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category;

  @IsOptional()
  @IsEnum(EventStatus)
  status;
}
