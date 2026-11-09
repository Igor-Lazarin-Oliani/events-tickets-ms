from dataclasses import dataclass
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.logs.models import ActivityLog, LogLevel, LogStatus


@dataclass
class LogFilters:
    entity_type: Optional[str] = None
    entity_id: Optional[UUID] = None
    action: Optional[str] = None
    level: Optional[LogLevel] = None
    status: Optional[LogStatus] = None
    source: Optional[str] = None
    correlation_id: Optional[str] = None
    include_archived: bool = False
    order: str = "desc"
    limit: int = 100
    offset: int = 0


class LogRepository:
    """Único ponto de acesso à tabela activity_logs."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, entry: ActivityLog) -> ActivityLog:
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry

    def rollback(self) -> None:
        self.db.rollback()

    def get_by_id(self, log_id: UUID) -> Optional[ActivityLog]:
        return self.db.get(ActivityLog, log_id)

    def exists_message(self, message_id: UUID) -> bool:
        query = select(ActivityLog.id).where(ActivityLog.message_id == message_id)
        return self.db.scalar(query) is not None

    def get_all(self, filters: LogFilters) -> list[ActivityLog]:
        query = select(ActivityLog)
        equality_filters = {
            ActivityLog.entity_type: filters.entity_type,
            ActivityLog.entity_id: filters.entity_id,
            ActivityLog.action: filters.action,
            ActivityLog.level: filters.level,
            ActivityLog.status: filters.status,
            ActivityLog.source: filters.source,
            ActivityLog.correlation_id: filters.correlation_id,
        }
        for column, value in equality_filters.items():
            if value is not None:
                query = query.where(column == value)
        if not filters.include_archived:
            query = query.where(ActivityLog.archived_at.is_(None))

        if filters.order == "asc":
            query = query.order_by(ActivityLog.occurred_at.asc(), ActivityLog.created_at.asc())
        else:
            query = query.order_by(ActivityLog.occurred_at.desc(), ActivityLog.created_at.desc())
        return list(self.db.scalars(query.limit(filters.limit).offset(filters.offset)))

    def update(self, entry: ActivityLog, changes: dict[str, Any]) -> ActivityLog:
        for field_name, value in changes.items():
            setattr(entry, field_name, value)
        self.db.commit()
        self.db.refresh(entry)
        return entry
