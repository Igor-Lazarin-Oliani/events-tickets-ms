from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Response, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.modules.events.models import EventStatus
from app.modules.events.repository import EventRepository
from app.modules.events.schemas import ErrorResponse, EventCreate, EventResponse, EventUpdate
from app.modules.events.service import EventService

router = APIRouter(prefix="/events", tags=["Events"])

EVENT_ID = Path(
    description="UUID do evento.",
    examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
)


def _error(description: str, detail: str) -> dict[str, Any]:
    return {
        "model": ErrorResponse,
        "description": description,
        "content": {"application/json": {"example": {"detail": detail}}},
    }


NOT_FOUND = {404: _error("Evento não encontrado.", "Event not found")}
INVALID_DATA = {422: {"description": "Dados de entrada inválidos."}}


def get_event_service(db: Session = Depends(get_db)) -> EventService:
    return EventService(EventRepository(db))


@router.post(
    "",
    response_model=EventResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Cria um evento",
    description="Cria o evento com `available_spots` igual a `max_capacity` e status `PUBLISHED`.",
    response_description="Evento criado.",
    responses=INVALID_DATA,
)
def create_event(payload: EventCreate, service: EventService = Depends(get_event_service)):
    return service.create_event(payload)


@router.get(
    "",
    response_model=list[EventResponse],
    summary="Lista os eventos",
    description="Lista os eventos, com filtros opcionais por categoria e status.",
    response_description="Eventos encontrados.",
    responses=INVALID_DATA,
)
def list_events(
    category: Optional[str] = Query(default=None, description="Categoria.", examples=["ACADEMIC"]),
    status_filter: Optional[EventStatus] = Query(
        default=None, alias="status", description="Status do evento."
    ),
    service: EventService = Depends(get_event_service),
):
    return service.list_events(category=category, status=status_filter)


@router.get(
    "/{id}",
    response_model=EventResponse,
    summary="Busca um evento",
    description="Retorna um evento. Também é usado pelo `tickets-service` para validar a inscrição.",
    response_description="Evento encontrado.",
    responses={**NOT_FOUND, **INVALID_DATA},
)
def get_event(id: UUID = EVENT_ID, service: EventService = Depends(get_event_service)):
    return service.get_event(id)


@router.put(
    "/{id}",
    response_model=EventResponse,
    summary="Atualiza um evento",
    description=(
        "Altera somente os campos enviados. Ao mudar `max_capacity`, as vagas ocupadas são "
        "preservadas, e o status alterna entre `PUBLISHED` e `SOLD_OUT` conforme as vagas livres. "
        "Mudar o status para `CANCELLED` publica `event.cancelled` no RabbitMQ, e os ingressos "
        "do evento são cancelados de forma assíncrona. Um evento cancelado não pode ser reaberto."
    ),
    response_description="Evento atualizado.",
    responses={
        **NOT_FOUND,
        409: _error(
            "Nova capacidade menor que as vagas ocupadas, ou evento cancelado sendo reaberto.",
            "max_capacity cannot be lower than the 5 occupied spots",
        ),
        **INVALID_DATA,
    },
)
def update_event(
    payload: EventUpdate,
    id: UUID = EVENT_ID,
    service: EventService = Depends(get_event_service),
):
    return service.update_event(id, payload)


@router.delete(
    "/{id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Remove um evento",
    description=(
        "Remove o evento e publica `event.deleted` no RabbitMQ. Os ingressos são cancelados de "
        "forma assíncrona e mantêm o snapshot do evento."
    ),
    response_description="Evento removido.",
    responses={**NOT_FOUND, **INVALID_DATA},
)
def delete_event(id: UUID = EVENT_ID, service: EventService = Depends(get_event_service)):
    service.delete_event(id)


@router.patch(
    "/{id}/reserve-spot",
    response_model=EventResponse,
    summary="Reserva uma vaga (integração)",
    description=(
        "**Rota interna, não exposta pelo API Gateway.** "
        "Usado pelo `tickets-service` na emissão do ingresso. Decrementa `available_spots` de "
        "forma atômica e muda o status para `SOLD_OUT` ao chegar a zero."
    ),
    response_description="Vaga reservada.",
    responses={
        **NOT_FOUND,
        409: _error("Evento sem vagas ou fechado para inscrições.", "Event is sold out"),
        **INVALID_DATA,
    },
)
def reserve_spot(id: UUID = EVENT_ID, service: EventService = Depends(get_event_service)):
    return service.reserve_spot(id)


@router.patch(
    "/{id}/release-spot",
    response_model=EventResponse,
    summary="Devolve uma vaga (integração)",
    description=(
        "**Rota interna, não exposta pelo API Gateway.** "
        "Usado pelo `tickets-service` no cancelamento e na compensação. Incrementa "
        "`available_spots` até `max_capacity` e retorna `SOLD_OUT` para `PUBLISHED`."
    ),
    response_description="Vaga devolvida, ou evento inalterado se já estiver na capacidade máxima.",
    responses={**NOT_FOUND, **INVALID_DATA},
)
def release_spot(id: UUID = EVENT_ID, service: EventService = Depends(get_event_service)):
    return service.release_spot(id)
