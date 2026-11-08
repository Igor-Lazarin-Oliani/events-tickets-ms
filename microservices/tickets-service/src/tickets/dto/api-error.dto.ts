import { ApiProperty } from '@nestjs/swagger';

export class ApiErrorDto {
  @ApiProperty({ example: 409 })
  statusCode: number;

  @ApiProperty({
    description: 'Motivo do erro. Em falhas de validação, é uma lista de mensagens.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Event is sold out',
  })
  message: string | string[];

  @ApiProperty({ example: 'Conflict' })
  error: string;
}
