import enum
import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import JSON, CheckConstraint, DateTime, Enum, Integer, String, Text, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EventModality(str, enum.Enum):
    IN_PERSON = "IN_PERSON"
    ONLINE = "ONLINE"
    HYBRID = "HYBRID"


class EventStatus(str, enum.Enum):
    PUBLISHED = "PUBLISHED"
    SOLD_OUT = "SOLD_OUT"
    CANCELLED = "CANCELLED"
    FINISHED = "FINISHED"


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint("max_capacity > 0", name="ck_events_max_capacity_positive"),
        CheckConstraint(
            "available_spots >= 0 AND available_spots <= max_capacity",
            name="ck_events_available_spots_range",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    modality: Mapped[EventModality] = mapped_column(
        Enum(EventModality, native_enum=False, length=20), nullable=False
    )
    location: Mapped[str] = mapped_column(String(500), nullable=False)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    max_capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    available_spots: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[EventStatus] = mapped_column(
        Enum(EventStatus, native_enum=False, length=20),
        nullable=False,
        default=EventStatus.PUBLISHED,
        index=True,
    )
    # "metadata" é um nome reservado pelo declarative do SQLAlchemy.
    metadata_info: Mapped[Optional[dict[str, Any]]] = mapped_column(
        JSON().with_variant(JSONB, "postgresql")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class OutboxMessage(Base):
    """Mensagem gravada na transação do evento e publicada depois no RabbitMQ."""

    __tablename__ = "outbox_messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    routing_key: Mapped[str] = mapped_column(String(100), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), index=True)
