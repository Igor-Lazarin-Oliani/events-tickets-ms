import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrorDto } from './dto/api-error.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { Ticket, TicketStatus } from './entities/ticket.entity';
import { TicketsService } from './tickets.service';

const TICKET_UUID_EXAMPLE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

@ApiTags('Tickets (Inscrições e Ingressos)')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post()
  @ApiOperation({
    summary: 'Realiza a inscrição e emite o ingresso',
    description:
      'Valida o evento no events-service, reserva uma vaga e salva o ingresso. Se o salvamento falhar, a vaga é devolvida.',
  })
  @ApiResponse({ status: 201, description: 'Ingresso emitido.', type: Ticket })
  @ApiResponse({
    status: 400,
    description: 'Dados inválidos ou evento fechado para inscrições.',
    type: ApiErrorDto,
  })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    description: 'Evento esgotado ou participante já inscrito.',
    type: ApiErrorDto,
  })
  @ApiResponse({ status: 500, description: 'Falha ao salvar o ingresso.', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'events-service indisponível.', type: ApiErrorDto })
  create(@Body() dto: CreateTicketDto): Promise<Ticket> {
    return this.ticketsService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista as inscrições e ingressos',
    description: 'Aceita filtros opcionais por evento, e-mail do participante e status.',
  })
  @ApiQuery({ name: 'event_id', required: false, description: 'UUID do evento.' })
  @ApiQuery({
    name: 'participant_email',
    required: false,
    description: 'E-mail do participante.',
    example: 'maria.silva@example.com',
  })
  @ApiQuery({ name: 'status', required: false, enum: TicketStatus })
  @ApiResponse({ status: 200, description: 'Ingressos encontrados.', type: [Ticket] })
  @ApiResponse({ status: 400, description: 'Filtro inválido.', type: ApiErrorDto })
  findAll(@Query() query: ListTicketsQueryDto): Promise<Ticket[]> {
    return this.ticketsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Consulta um ingresso',
    description: 'Busca pelo UUID ou pelo código do ingresso.',
  })
  @ApiParam({ name: 'id', description: 'UUID ou ticket_code.', example: 'EVT-2026-A8F9K2' })
  @ApiResponse({ status: 200, description: 'Ingresso encontrado.', type: Ticket })
  @ApiResponse({ status: 404, description: 'Ingresso não encontrado.', type: ApiErrorDto })
  findOne(@Param('id') id: string): Promise<Ticket> {
    return this.ticketsService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Atualiza o ingresso ou realiza o check-in',
    description:
      'Altera somente os campos enviados. Envie status CHECKED_IN para registrar a presença de um ingresso CONFIRMED.',
  })
  @ApiParam({ name: 'id', description: 'UUID do ingresso.', example: TICKET_UUID_EXAMPLE })
  @ApiResponse({ status: 200, description: 'Ingresso atualizado.', type: Ticket })
  @ApiResponse({ status: 400, description: 'Dados inválidos.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Ingresso não encontrado.', type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    description: 'Ingresso cancelado, check-in repetido ou documento já inscrito no evento.',
    type: ApiErrorDto,
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketDto,
  ): Promise<Ticket> {
    return this.ticketsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Cancela o ingresso e devolve a vaga',
    description:
      'Muda o status para CANCELLED, mantém o registro e devolve a vaga no events-service.',
  })
  @ApiParam({ name: 'id', description: 'UUID do ingresso.', example: TICKET_UUID_EXAMPLE })
  @ApiResponse({ status: 200, description: 'Ingresso cancelado.', type: Ticket })
  @ApiResponse({ status: 400, description: 'UUID inválido.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Ingresso não encontrado.', type: ApiErrorDto })
  @ApiResponse({ status: 409, description: 'Ingresso já cancelado.', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'events-service indisponível.', type: ApiErrorDto })
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<Ticket> {
    return this.ticketsService.cancel(id);
  }
}
