import enum
import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import JSON, DateTime, Enum, Index, String, Text, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class LogLevel(str, enum.Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"


class LogStatus(str, enum.Enum):
    """Triagem feita por quem acompanha os registros; é a única parte editável."""

    NEW = "NEW"
    REVIEWED = "REVIEWED"
    RESOLVED = "RESOLVED"


MANUAL_SOURCE = "manual"


class ActivityLog(Base):
    """Registro de atividade. O que aconteceu é imutável; só status e notes mudam (D19)."""

    __tablename__ = "activity_logs"
    __table_args__ = (Index("ix_activity_logs_entity", "entity_type", "entity_id"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Vem da mensagem do RabbitMQ; o índice único descarta entregas repetidas.
    message_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, unique=True)
    source: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    entity_type: Mapped[Optional[str]] = mapped_column(String(50))
    entity_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid)
    level: Mapped[LogLevel] = mapped_column(
        Enum(LogLevel, native_enum=False, length=10),
        nullable=False,
        default=LogLevel.INFO,
        index=True,
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    correlation_id: Mapped[Optional[str]] = mapped_column(String(128), index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    status: Mapped[LogStatus] = mapped_column(
        Enum(LogStatus, native_enum=False, length=10),
        nullable=False,
        default=LogStatus.NEW,
        index=True,
    )
    notes: Mapped[Optional[str]] = mapped_column(Text)
    # Exclusão lógica: o registro sai das listagens, mas o message_id continua barrando repetições.
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
