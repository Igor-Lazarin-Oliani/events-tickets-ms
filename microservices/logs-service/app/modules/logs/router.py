from typing import Any, Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.modules.logs.models import LogLevel, LogStatus
from app.modules.logs.repository import LogFilters, LogRepository
from app.modules.logs.schemas import ErrorResponse, LogCreate, LogResponse, LogUpdate
from app.modules.logs.service import LogService

router = APIRouter(prefix="/logs", tags=["Logs (Registro de atividades)"])

LOG_ID = Path(
    description="UUID do registro.",
    examples=["1b4e28ba-2fa1-41d2-883f-0016d3cca427"],
)


def _error(description: str, detail: str) -> dict[str, Any]:
    return {
        "model": ErrorResponse,
        "description": description,
        "content": {"application/json": {"example": {"detail": detail}}},
    }


NOT_FOUND = {404: _error("Registro não encontrado.", "Log entry not found")}
INVALID_DATA = {422: {"description": "Dados de entrada inválidos ou campo não editável."}}


def get_log_service(db: Session = Depends(get_db)) -> LogService:
    return LogService(LogRepository(db))


@router.post(
    "",
    response_model=LogResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Cria um registro manual",
    description=(
        "Registra uma ocorrência que não veio do RabbitMQ, como uma anotação da organização. "
        "Os registros automáticos chegam pelo consumidor da fila `logs.activity`."
    ),
    response_description="Registro criado com status NEW.",
    responses=INVALID_DATA,
)
def create_log(payload: LogCreate, service: LogService = Depends(get_log_service)):
    return service.create_log(payload)


@router.get(
    "",
    response_model=list[LogResponse],
    summary="Lista os registros",
    description=(
        "Lista os registros com filtros opcionais. Os arquivados ficam de fora, a menos que "
        "`include_archived=true`. O `events-tickets-service` usa esta rota para montar o histórico "
        "de um evento ou ingresso."
    ),
    response_description="Registros encontrados.",
    responses=INVALID_DATA,
)
def list_logs(
    entity_type: Optional[str] = Query(default=None, examples=["ticket"]),
    entity_id: Optional[UUID] = Query(default=None),
    action: Optional[str] = Query(default=None, examples=["ticket.issued"]),
    level: Optional[LogLevel] = Query(default=None),
    status_filter: Optional[LogStatus] = Query(default=None, alias="status"),
    source: Optional[str] = Query(default=None, examples=["events-tickets-service"]),
    correlation_id: Optional[str] = Query(default=None, examples=["demo-123"]),
    include_archived: bool = Query(default=False, description="Inclui os arquivados."),
    order: Literal["asc", "desc"] = Query(
        default="desc", description="Ordem por `occurred_at`; `asc` é a cronológica."
    ),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    service: LogService = Depends(get_log_service),
):
    filters = LogFilters(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        level=level,
        status=status_filter,
        source=source,
        correlation_id=correlation_id,
        include_archived=include_archived,
        order=order,
        limit=limit,
        offset=offset,
    )
    return service.list_logs(filters)


@router.get(
    "/{id}",
    response_model=LogResponse,
    summary="Busca um registro",
    description="Retorna o registro, inclusive se estiver arquivado (`archived_at` preenchido).",
    response_description="Registro encontrado.",
    responses={**NOT_FOUND, **INVALID_DATA},
)
def get_log(id: UUID = LOG_ID, service: LogService = Depends(get_log_service)):
    return service.get_log(id)


@router.put(
    "/{id}",
    response_model=LogResponse,
    summary="Atualiza a triagem do registro",
    description=(
        "Altera somente `status` e `notes`. O que aconteceu (ação, entidade, mensagem, dados e "
        "data) é imutável: enviar esses campos responde 422."
    ),
    response_description="Registro atualizado.",
    responses={
        **NOT_FOUND,
        409: _error("Registro arquivado.", "Archived log entry cannot be modified"),
        **INVALID_DATA,
    },
)
def update_log(
    payload: LogUpdate,
    id: UUID = LOG_ID,
    service: LogService = Depends(get_log_service),
):
    return service.update_log(id, payload)


@router.delete(
    "/{id}",
    response_model=LogResponse,
    summary="Arquiva o registro",
    description=(
        "Exclusão lógica: preenche `archived_at` e tira o registro das listagens e dos históricos. "
        "O registro continua no banco, e uma reentrega da mesma mensagem não o recria."
    ),
    response_description="Registro arquivado.",
    responses={
        **NOT_FOUND,
        409: _error("Registro já arquivado.", "Log entry is already archived"),
        **INVALID_DATA,
    },
)
def archive_log(id: UUID = LOG_ID, service: LogService = Depends(get_log_service)):
    return service.archive_log(id)
