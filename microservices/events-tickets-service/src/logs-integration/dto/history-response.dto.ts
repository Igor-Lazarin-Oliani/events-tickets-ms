import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ActivityLogEntryDto {
  @ApiProperty({ format: 'uuid', example: '1b4e28ba-2fa1-41d2-883f-0016d3cca427' })
  id: string;

  @ApiProperty({ example: 'ticket.issued' })
  action: string;

  @ApiProperty({ enum: ['INFO', 'WARNING', 'ERROR'], example: 'INFO' })
  level: string;

  @ApiProperty({ example: 'Ticket EVT-2026-A8F9K2 issued' })
  message: string;

  @ApiPropertyOptional({
    example: { ticket_code: 'EVT-2026-A8F9K2', status: 'CONFIRMED', modality_tier: 'ESTUDANTE' },
  })
  data: Record<string, unknown> | null;

  @ApiProperty({ example: 'events-tickets-service' })
  source: string;

  @ApiPropertyOptional({ example: 'demo-123' })
  correlation_id: string | null;

  @ApiProperty({ example: '2026-11-20T12:00:00.000Z' })
  occurred_at: string;

  @ApiProperty({ enum: ['NEW', 'REVIEWED', 'RESOLVED'], example: 'NEW' })
  status: string;

  @ApiPropertyOptional({ example: null })
  notes: string | null;
}

export class HistoryResponseDto {
  @ApiProperty({ enum: ['event', 'ticket'], example: 'ticket' })
  entity_type: string;

  @ApiProperty({ format: 'uuid', example: '7c9e6679-7425-40de-944b-e07fc1f90ae7' })
  entity_id: string;

  @ApiProperty({
    description:
      'Total de atividades da entidade no logs-service, sem os arquivados. Se offset + entries.length for ' +
      'menor que total, há mais páginas. É null se o logs-service não informar o total.',
    type: 'integer',
    nullable: true,
    example: 3,
  })
  total: number | null;

  @ApiProperty({ description: 'Tamanho da página pedida.', example: 500 })
  limit: number;

  @ApiProperty({ description: 'Quantas atividades foram puladas.', example: 0 })
  offset: number;

  @ApiProperty({
    description: 'Registros do logs-service em ordem cronológica, sem os arquivados.',
    type: [ActivityLogEntryDto],
  })
  entries: ActivityLogEntryDto[];
}
