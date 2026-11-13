import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { CreateEventDto } from './dto/create-event.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { Event, EventStatus } from './entities/event.entity';
import { EventsService } from './events.service';

const EVENT_UUID_EXAMPLE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

@ApiTags('Events (Eventos e vagas)')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @ApiOperation({
    summary: 'Cria um evento',
    description:
      'Cria o evento com available_spots igual a max_capacity e status PUBLISHED, e registra event.created no logs-service.',
  })
  @ApiResponse({ status: 201, description: 'Evento criado.', type: Event })
  @ApiResponse({
    status: 400,
    description: 'Dados inválidos, data sem fuso ou fim antes do início.',
    type: ApiErrorDto,
  })
  create(@Body() dto: CreateEventDto): Promise<Event> {
    return this.eventsService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista os eventos',
    description:
      'Aceita filtros opcionais por categoria e status. A lista é paginada, dos eventos mais recentes aos ' +
      'mais antigos, e o cabeçalho X-Total-Count traz o total que atende aos filtros.',
  })
  @ApiQuery({ name: 'category', required: false, example: 'ACADEMIC' })
  @ApiQuery({ name: 'status', required: false, enum: EventStatus })
  @ApiPagination(DEFAULT_LIST_LIMIT)
  @ApiResponse({
    status: 200,
    description: 'Página de eventos.',
    type: [Event],
    headers: TOTAL_COUNT_RESPONSE_HEADER,
  })
  @ApiResponse({ status: 400, description: 'Filtro ou paginação inválidos.', type: ApiErrorDto })
  async findAll(
    @Query() query: ListEventsQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Event[]> {
    const page = await this.eventsService.findAll(query);
    response.setHeader(TOTAL_COUNT_HEADER, String(page.total));
    return page.items;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Busca um evento' })
  @ApiParam({ name: 'id', description: 'UUID do evento.', example: EVENT_UUID_EXAMPLE })
  @ApiResponse({ status: 200, description: 'Evento encontrado.', type: Event })
  @ApiResponse({ status: 400, description: 'UUID inválido.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Event> {
    return this.eventsService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Atualiza um evento',
    description:
      'Altera somente os campos enviados. Ao mudar max_capacity, as vagas ocupadas são preservadas, e o status ' +
      'alterna entre PUBLISHED e SOLD_OUT conforme as vagas livres. Mudar o status para CANCELLED cancela os ' +
      'ingressos ativos na mesma transação; um evento cancelado não pode ser reaberto.',
  })
  @ApiParam({ name: 'id', description: 'UUID do evento.', example: EVENT_UUID_EXAMPLE })
  @ApiResponse({ status: 200, description: 'Evento atualizado.', type: Event })
  @ApiResponse({ status: 400, description: 'Dados inválidos.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    description: 'Nova capacidade menor que as vagas ocupadas, ou evento cancelado sendo reaberto.',
    type: ApiErrorDto,
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEventDto,
  ): Promise<Event> {
    return this.eventsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove um evento',
    description:
      'Remove o evento e cancela os ingressos ativos na mesma transação. Os ingressos mantêm o event_snapshot, ' +
      'e o histórico do evento continua no logs-service.',
  })
  @ApiParam({ name: 'id', description: 'UUID do evento.', example: EVENT_UUID_EXAMPLE })
  @ApiResponse({ status: 204, description: 'Evento removido.' })
  @ApiResponse({ status: 400, description: 'UUID inválido.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.eventsService.remove(id);
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'Histórico do evento',
    description:
      'Consulta o logs-service por HTTP e devolve as atividades do evento em ordem cronológica, inclusive as ' +
      'reservas e devoluções de vagas. É paginado: total indica quantas atividades existem, e offset busca as ' +
      'seguintes. Se o logs-service estiver fora do ar, responde 503 e o resto da API segue funcionando.',
  })
  @ApiParam({ name: 'id', description: 'UUID do evento.', example: EVENT_UUID_EXAMPLE })
  @ApiPagination(DEFAULT_HISTORY_LIMIT)
  @ApiResponse({ status: 200, description: 'Histórico do evento.', type: HistoryResponseDto })
  @ApiResponse({ status: 400, description: 'UUID ou paginação inválidos.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'logs-service indisponível.', type: ApiErrorDto })
  getHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<HistoryResponseDto> {
    return this.eventsService.getHistory(id, query);
  }
}
