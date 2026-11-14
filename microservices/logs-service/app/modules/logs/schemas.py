from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from app.modules.logs.models import MANUAL_SOURCE, LogLevel, LogStatus

# Ação no formato "<entidade>.<verbo>", como ticket.issued ou incident.reported.
ACTION_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"
ENTITY_TYPE_PATTERN = r"^[a-z][a-z0-9_]*$"

LOG_EXAMPLE = {
    "id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
    "message_id": "5a1e7c2e-9a55-4b2f-8f35-2f1b7e8a4c10",
    "source": "tickets-service",
    "action": "ticket.issued",
    "entity_type": "ticket",
    "entity_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "level": "INFO",
    "message": "Ticket EVT-2026-A8F9K2 issued",
    "data": {
        "ticket_code": "EVT-2026-A8F9K2",
        "event_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "status": "CONFIRMED",
        "modality_tier": "ESTUDANTE",
    },
    "correlation_id": "demo-123",
    "occurred_at": "2026-11-20T12:00:00Z",
    "status": "NEW",
    "notes": None,
    "archived_at": None,
    "created_at": "2026-11-20T12:00:01Z",
    "updated_at": "2026-11-20T12:00:01Z",
}


class LogCreate(BaseModel):
    """Registro manual, como uma ocorrência anotada pela organização do evento."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "example": {
                "action": "incident.reported",
                "entity_type": "event",
                "entity_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                "level": "WARNING",
                "message": "Projetor do auditório com defeito; palestra atrasou 15 minutos.",
                "data": {"sala": "Auditório da FACOM"},
            }
        },
    )

    action: str = Field(pattern=ACTION_PATTERN, max_length=100)
    message: str = Field(min_length=1, max_length=2000)
    level: LogLevel = LogLevel.INFO
    entity_type: Optional[str] = Field(default=None, pattern=ENTITY_TYPE_PATTERN, max_length=50)
    entity_id: Optional[UUID] = None
    data: Optional[dict[str, Any]] = None
    source: str = Field(default=MANUAL_SOURCE, min_length=1, max_length=100)
    correlation_id: Optional[str] = Field(default=None, max_length=128)
    occurred_at: Optional[AwareDatetime] = Field(
        default=None, description="Quando aconteceu; o padrão é o momento do registro."
    )
    notes: Optional[str] = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def require_type_with_entity(self) -> "LogCreate":
        if self.entity_id is not None and self.entity_type is None:
            raise ValueError("entity_type is required when entity_id is sent")
        return self


class LogUpdate(BaseModel):
    """Triagem: só status e notes mudam. Qualquer outro campo responde 422."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "example": {"status": "REVIEWED", "notes": "Conferido com a organização do evento."}
        },
    )

    status: Optional[LogStatus] = None
    notes: Optional[str] = Field(default=None, max_length=2000, description="Aceita null para apagar.")

    @model_validator(mode="after")
    def reject_null_status(self) -> "LogUpdate":
        if "status" in self.model_fields_set and self.status is None:
            raise ValueError("status cannot be null")
        return self


class LogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, json_schema_extra={"example": LOG_EXAMPLE})

    id: UUID
    message_id: Optional[UUID]
    source: str
    action: str
    entity_type: Optional[str]
    entity_id: Optional[UUID]
    level: LogLevel
    message: str
    data: Optional[dict[str, Any]]
    correlation_id: Optional[str]
    occurred_at: datetime
    status: LogStatus
    notes: Optional[str]
    archived_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime


class ActivityMessage(BaseModel):
    """Corpo das atividades publicadas pelo events-service e pelo tickets-service no RabbitMQ."""

    model_config = ConfigDict(extra="ignore")

    message_id: UUID
    action: str = Field(pattern=ACTION_PATTERN, max_length=100)
    entity_type: str = Field(pattern=ENTITY_TYPE_PATTERN, max_length=50)
    entity_id: UUID
    level: LogLevel = LogLevel.INFO
    message: str = Field(min_length=1, max_length=2000)
    data: Optional[dict[str, Any]] = None
    source: str = Field(min_length=1, max_length=100)
    occurred_at: AwareDatetime
    correlation_id: Optional[str] = Field(default=None, max_length=128)


class ErrorResponse(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"detail": "Log entry not found"}})

    detail: str
