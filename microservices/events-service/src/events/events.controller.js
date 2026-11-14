import {
  Bind,
  Controller,
  Delete,
  Dependencies,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorDto } from '../common/api-error.dto';
import {
  ApiPagination,
  DEFAULT_LIST_LIMIT,
  PaginationQueryDto,
  TOTAL_COUNT_HEADER,
  TOTAL_COUNT_RESPONSE_HEADER,
} from '../common/pagination';
import { ValidBody, ValidQuery } from '../common/validation';
import { HistoryResponseDto } from '../logs-integration/dto/history-response.dto';
import { DEFAULT_HISTORY_LIMIT } from '../logs-integration/logs-client.service';
import { CreateEventDto } from './dto/create-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { ReserveSpotDto } from './dto/reserve-spot.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventStatus } from './entities/event.entity';
import { EventsService } from './events.service';

const EVENT_UUID_EXAMPLE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const EventId = () => Param('id', ParseUUIDPipe);
const EventIdParam = () =>
  ApiParam({ name: 'id', description: 'UUID do evento.', example: EVENT_UUID_EXAMPLE });

// Em JavaScript não há decorators de parâmetro: @Bind associa cada um à posição do argumento (D35).
@ApiTags('Events (Eventos e vagas)')
@Controller('events')
@Dependencies(EventsService)
export class EventsController {
  constructor(eventsService) {
    this.eventsService = eventsService;
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um evento',
    description:
      'Cria o evento com available_spots igual a max_capacity e status PUBLISHED, e registra event.created no logs-service.',
  })
  @ApiBody({ type: CreateEventDto })
  @ApiResponse({ status: 201, description: 'Evento criado.', type: EventResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Dados inválidos, data sem fuso ou fim antes do início.',
    type: ApiErrorDto,
  })
  @Bind(ValidBody(CreateEventDto))
  create(dto) {
    return this.eventsService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista os eventos',
    description:
      'Aceita filtros opcionais por categoria e status. A lista é paginada, dos eventos mais recentes aos ' +
      'mais antigos, e o cabeçalho X-Total-Count traz o total que atende aos filtros.',
  })
  @ApiQuery({ name: 'category', required: false, example: 'ACADEMIC', type: String })
  @ApiQuery({ name: 'status', required: false, enum: EventStatus })
  @ApiPagination(DEFAULT_LIST_LIMIT)
  @ApiResponse({
    status: 200,
    description: 'Página de eventos.',
    type: [EventResponseDto],
    headers: TOTAL_COUNT_RESPONSE_HEADER,
  })
  @ApiResponse({ status: 400, description: 'Filtro ou paginação inválidos.', type: ApiErrorDto })
  @Bind(ValidQuery(ListEventsQueryDto), Res({ passthrough: true }))
  async findAll(query, response) {
    const page = await this.eventsService.findAll(query);
    response.setHeader(TOTAL_COUNT_HEADER, String(page.total));
    return page.items;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Busca um evento' })
  @EventIdParam()
  @ApiResponse({ status: 200, description: 'Evento encontrado.', type: EventResponseDto })
  @ApiResponse({ status: 400, description: 'UUID inválido.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  @Bind(EventId())
  findOne(id) {
    return this.eventsService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Atualiza um evento',
    description:
      'Altera somente os campos enviados. Ao mudar max_capacity, as vagas ocupadas são preservadas, e o status ' +
      'alterna entre PUBLISHED e SOLD_OUT conforme as vagas livres. Mudar o status para CANCELLED avisa o ' +
      'tickets-service pelo RabbitMQ, que cancela os ingressos ativos em cerca de 1 s; um evento cancelado não ' +
      'pode ser reaberto.',
  })
  @EventIdParam()
  @ApiBody({ type: UpdateEventDto })
  @ApiResponse({ status: 200, description: 'Evento atualizado.', type: EventResponseDto })
  @ApiResponse({ status: 400, description: 'Dados inválidos.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    description: 'Nova capacidade menor que as vagas ocupadas, ou evento cancelado sendo reaberto.',
    type: ApiErrorDto,
  })
  @Bind(EventId(), ValidBody(UpdateEventDto))
  update(id, dto) {
    return this.eventsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove um evento',
    description:
      'Remove o evento e avisa o tickets-service pelo RabbitMQ, que cancela os ingressos ativos em cerca de 1 s. ' +
      'Os ingressos mantêm o event_snapshot, e o histórico do evento continua no logs-service.',
  })
  @EventIdParam()
  @ApiResponse({ status: 204, description: 'Evento removido.' })
  @ApiResponse({ status: 400, description: 'UUID inválido.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  @Bind(EventId())
  async remove(id) {
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
  @EventIdParam()
  @ApiPagination(DEFAULT_HISTORY_LIMIT)
  @ApiResponse({ status: 200, description: 'Histórico do evento.', type: HistoryResponseDto })
  @ApiResponse({ status: 400, description: 'UUID ou paginação inválidos.', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'logs-service indisponível.', type: ApiErrorDto })
  @Bind(EventId(), ValidQuery(PaginationQueryDto))
  getHistory(id, query) {
    return this.eventsService.getHistory(id, query);
  }

  @Patch(':id/reserve-spot')
  @ApiOperation({
    summary: 'Reserva uma vaga (integração)',
    description:
      '**Rota interna, não exposta pelo API Gateway.** Chamada pelo tickets-service antes de salvar o ingresso. ' +
      'Decrementa available_spots com um UPDATE condicional, muda o status para SOLD_OUT ao chegar a zero e ' +
      'registra a reserva pelo ticket_id: repetir a chamada com o mesmo ticket_id devolve a mesma vaga. A ' +
      'devolução não tem rota: chega pelo RabbitMQ.',
  })
  @EventIdParam()
  @ApiBody({ type: ReserveSpotDto })
  @ApiResponse({ status: 200, description: 'Vaga reservada.', type: EventResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Dados inválidos, evento já encerrado ou evento CANCELLED ou FINISHED.',
    type: ApiErrorDto,
  })
  @ApiResponse({ status: 404, description: 'Evento não encontrado.', type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    description:
      'Evento esgotado, evento que fechou ou terminou durante a reserva, ou reserva deste ticket_id já devolvida.',
    type: ApiErrorDto,
  })
  @Bind(EventId(), ValidBody(ReserveSpotDto))
  reserveSpot(id, dto) {
    return this.eventsService.reserveSpot(id, dto.ticket_id);
  }
}
