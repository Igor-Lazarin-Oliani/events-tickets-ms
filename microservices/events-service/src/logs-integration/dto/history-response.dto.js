import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ActivityLogEntryDto {
  @ApiProperty({ type: String, format: 'uuid', example: '1b4e28ba-2fa1-41d2-883f-0016d3cca427' })
  id;

  @ApiProperty({ type: String, example: 'event.spot_reserved' })
  action;

  @ApiProperty({ enum: ['INFO', 'WARNING', 'ERROR'], example: 'INFO' })
  level;

  @ApiProperty({ type: String, example: 'Spot reserved for ticket 7c9e6679-7425-40de-944b-e07fc1f90ae7' })
  message;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { title: 'Workshop Docker', status: 'PUBLISHED', available_spots: 1, max_capacity: 2 },
  })
  data;

  @ApiProperty({ type: String, example: 'events-service' })
  source;

  @ApiPropertyOptional({ type: String, example: 'demo-123' })
  correlation_id;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-20T12:00:00.000Z' })
  occurred_at;

  @ApiProperty({ enum: ['NEW', 'REVIEWED', 'RESOLVED'], example: 'NEW' })
  status;

  @ApiPropertyOptional({ type: String, example: null, nullable: true })
  notes;
}

export class HistoryResponseDto {
  @ApiProperty({ enum: ['event'], example: 'event' })
  entity_type;

  @ApiProperty({ type: String, format: 'uuid', example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  entity_id;

  @ApiProperty({
    type: 'integer',
    description:
      'Total de atividades do evento no logs-service, sem os arquivados. Se offset + entries.length for ' +
      'menor que total, há mais páginas. É null se o logs-service não informar o total.',
    nullable: true,
    example: 3,
  })
  total;

  @ApiProperty({ type: Number, description: 'Tamanho da página pedida.', example: 500 })
  limit;

  @ApiProperty({ type: Number, description: 'Quantas atividades foram puladas.', example: 0 })
  offset;

  @ApiProperty({
    description: 'Registros do logs-service em ordem cronológica, sem os arquivados.',
    type: [ActivityLogEntryDto],
  })
  entries;
}
