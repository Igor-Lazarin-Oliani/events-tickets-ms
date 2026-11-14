import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Corpo da rota interna de reserva, chamada pelo tickets-service (D30). */
export class ReserveSpotDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'Id do ingresso que o tickets-service vai salvar. É a chave de idempotência: repetir a reserva com o ' +
      'mesmo id devolve a mesma vaga, sem reservar outra.',
    example: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  })
  @IsUUID()
  ticket_id;
}
