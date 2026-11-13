import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ApiErrorDto } from '../common/api-error.dto';
import {
  ApiPagination,
  DEFAULT_LIST_LIMIT,
  PaginationQueryDto,
  TOTAL_COUNT_HEADER,
  TOTAL_COUNT_RESPONSE_HEADER,
} from '../common/pagination';
import { HistoryResponseDto } from '../logs-integration/dto/history-response.dto';
import { DEFAULT_HISTORY_LIMIT } from '../logs-integration/logs-client.service';
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
      'Valida o evento, reserva uma vaga e salva o ingresso em uma única transação: se algo falhar, nada é gravado e a vaga não é consumida. ' +
      'Só aceita inscrições em evento existente, PUBLISHED, com vaga e que ainda não terminou (end_at no futuro).',
  })
  @ApiResponse({ status: 201, description: 'Ingresso emitido.', type: Ticket })
  @ApiResponse({
    status: 400,
    description:
      'Dados inválidos, evento já encerrado (Event has already ended) ou evento CANCELLED ou FINISHED.',
    type: ApiErrorDto,
  })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    description:
      'Evento esgotado, participante já inscrito, ou evento que fechou ou terminou entre a consulta e a reserva.',
    type: ApiErrorDto,
  })
  @ApiResponse({ status: 500, description: 'Falha ao salvar o ingresso.', type: ApiErrorDto })
  create(@Body() dto: CreateTicketDto): Promise<Ticket> {
    return this.ticketsService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista as inscrições e ingressos',
    description:
      'Aceita filtros opcionais por evento, e-mail do participante e status. A lista é paginada, dos ingressos ' +
      'mais recentes aos mais antigos, e o cabeçalho X-Total-Count traz o total que atende aos filtros.',
  })
  @ApiQuery({ name: 'event_id', required: false, description: 'UUID do evento.' })
  @ApiQuery({
    name: 'participant_email',
    required: false,
    description: 'E-mail do participante.',
    example: 'maria.silva@example.com',
  })
  @ApiQuery({ name: 'status', required: false, enum: TicketStatus })
  @ApiPagination(DEFAULT_LIST_LIMIT)
  @ApiResponse({
    status: 200,
    description: 'Página de ingressos.',
    type: [Ticket],
    headers: TOTAL_COUNT_RESPONSE_HEADER,
  })
  @ApiResponse({ status: 400, description: 'Filtro ou paginação inválidos.', type: ApiErrorDto })
  async findAll(
    @Query() query: ListTicketsQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Ticket[]> {
    const page = await this.ticketsService.findAll(query);
    response.setHeader(TOTAL_COUNT_HEADER, String(page.total));
    return page.items;
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
      'Muda o status para CANCELLED, mantém o registro e devolve a vaga ao evento na mesma transação.',
  })
  @ApiParam({ name: 'id', description: 'UUID do ingresso.', example: TICKET_UUID_EXAMPLE })
  @ApiResponse({ status: 200, description: 'Ingresso cancelado.', type: Ticket })
  @ApiResponse({ status: 400, description: 'UUID inválido.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Ingresso não encontrado.', type: ApiErrorDto })
  @ApiResponse({ status: 409, description: 'Ingresso já cancelado.', type: ApiErrorDto })
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<Ticket> {
    return this.ticketsService.cancel(id);
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'Histórico do ingresso',
    description:
      'Consulta o logs-service por HTTP e devolve as atividades do ingresso em ordem cronológica. ' +
      'É paginado: total indica quantas atividades existem, e offset busca as seguintes. ' +
      'Se o logs-service estiver fora do ar, responde 503 e o resto da API segue funcionando.',
  })
  @ApiParam({ name: 'id', description: 'UUID ou ticket_code.', example: 'EVT-2026-A8F9K2' })
  @ApiPagination(DEFAULT_HISTORY_LIMIT)
  @ApiResponse({ status: 200, description: 'Histórico do ingresso.', type: HistoryResponseDto })
  @ApiResponse({ status: 400, description: 'Paginação inválida.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Ingresso não encontrado.', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'logs-service indisponível.', type: ApiErrorDto })
  getHistory(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<HistoryResponseDto> {
    return this.ticketsService.getHistory(id, query);
  }
}
