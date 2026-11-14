import { ApiProperty } from '@nestjs/swagger';

/** Formato dos erros do NestJS, só para documentar as respostas no Swagger. */
export class ApiErrorDto {
  @ApiProperty({ type: Number, example: 409 })
  statusCode;

  // Texto ou lista: o tipo Object é o mesmo que o TypeScript refletiria para essa união.
  @ApiProperty({
    type: Object,
    description: 'Motivo do erro. Em falhas de validação, é uma lista de mensagens.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Event is sold out',
  })
  message;

  @ApiProperty({ type: String, example: 'Conflict' })
  error;
}
