from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from app.modules.events.models import EventModality, EventStatus

# Limite da coluna INTEGER do PostgreSQL.
MAX_CAPACITY_LIMIT = 2_147_483_647


class EventCreate(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "title": "Semana da Computação UFMS",
                "description": "Palestras e minicursos para a comunidade acadêmica.",
                "category": "ACADEMIC",
                "modality": "IN_PERSON",
                "location": "Auditório da FACOM, Campo Grande - MS",
                "start_at": "2026-11-20T08:00:00-04:00",
                "end_at": "2026-11-20T18:00:00-04:00",
                "max_capacity": 2,
                "metadata_info": {"palestrante": "Profa. Ana Souza", "carga_horaria": 10},
            }
        }
    )

    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    category: str = Field(default="GENERAL", min_length=1, max_length=50)
    modality: EventModality
    location: str = Field(min_length=1, max_length=500)
    start_at: AwareDatetime
    end_at: AwareDatetime
    max_capacity: int = Field(gt=0, le=MAX_CAPACITY_LIMIT)
    metadata_info: Optional[dict[str, Any]] = None

    @model_validator(mode="after")
    def validate_period(self) -> "EventCreate":
        if self.end_at <= self.start_at:
            raise ValueError("end_at must be after start_at")
        return self


class EventUpdate(BaseModel):
    """Atualização parcial: somente os campos enviados são alterados."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "title": "Semana da Computação UFMS 2026",
                "location": "Anfiteatro da UFMS, Campo Grande - MS",
                "max_capacity": 150,
                "status": "PUBLISHED",
            }
        }
    )

    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    category: Optional[str] = Field(default=None, min_length=1, max_length=50)
    modality: Optional[EventModality] = None
    location: Optional[str] = Field(default=None, min_length=1, max_length=500)
    start_at: Optional[AwareDatetime] = None
    end_at: Optional[AwareDatetime] = None
    max_capacity: Optional[int] = Field(default=None, gt=0, le=MAX_CAPACITY_LIMIT)
    status: Optional[EventStatus] = None
    metadata_info: Optional[dict[str, Any]] = None

    @model_validator(mode="after")
    def reject_null_on_required_columns(self) -> "EventUpdate":
        nullable_fields = {"description", "metadata_info"}
        for field_name in self.model_fields_set - nullable_fields:
            if getattr(self, field_name) is None:
                raise ValueError(f"{field_name} cannot be null")
        return self


class EventResponse(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,
        json_schema_extra={
            "example": {
                "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                "title": "Semana da Computação UFMS",
                "description": "Palestras e minicursos para a comunidade acadêmica.",
                "category": "ACADEMIC",
                "modality": "IN_PERSON",
                "location": "Auditório da FACOM, Campo Grande - MS",
                "start_at": "2026-11-20T12:00:00Z",
                "end_at": "2026-11-20T22:00:00Z",
                "max_capacity": 2,
                "available_spots": 2,
                "status": "PUBLISHED",
                "metadata_info": {"palestrante": "Profa. Ana Souza", "carga_horaria": 10},
                "created_at": "2026-11-08T20:00:00Z",
                "updated_at": "2026-11-08T20:00:00Z",
            }
        },
    )

    id: UUID
    title: str
    description: Optional[str]
    category: str
    modality: EventModality
    location: str
    start_at: datetime
    end_at: datetime
    max_capacity: int
    available_spots: int
    status: EventStatus
    metadata_info: Optional[dict[str, Any]]
    created_at: datetime
    updated_at: datetime


class ErrorResponse(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"detail": "Event not found"}})

    detail: str
