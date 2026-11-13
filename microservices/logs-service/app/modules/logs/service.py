from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy.exc import IntegrityError

from app.core.telemetry import LOG_ENTRIES_CREATED, correlation_id_var, log_event
from app.modules.logs.models import ActivityLog
from app.modules.logs.repository import LogFilters, LogRepository
from app.modules.logs.schemas import ActivityMessage, LogCreate, LogUpdate


class LogDomainError(Exception):
    status_code = 400

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class LogNotFoundError(LogDomainError):
    status_code = 404

    def __init__(self) -> None:
        super().__init__("Log entry not found")


class LogConflictError(LogDomainError):
    status_code = 409


class LogService:
    def __init__(self, repository: LogRepository) -> None:
        self.repository = repository

    def create_log(self, payload: LogCreate) -> ActivityLog:
        fields = payload.model_dump(exclude={"occurred_at", "correlation_id"})
        request_correlation_id = correlation_id_var.get()
        entry = self.repository.add(
            ActivityLog(
                **fields,
                message_id=None,
                # Sem valor no corpo, vale o X-Correlation-Id da própria requisição.
                correlation_id=payload.correlation_id
                or (request_correlation_id if request_correlation_id != "-" else None),
                occurred_at=payload.occurred_at or datetime.now(timezone.utc),
            )
        )
        LOG_ENTRIES_CREATED.labels(origin="api").inc()
        log_event("LOG ENTRY CREATED", log_id=entry.id, action=entry.action, origin="api")
        return entry

    def record_message(self, message: ActivityMessage) -> bool:
        """Grava a mensagem do RabbitMQ; False se ela já tinha sido gravada (entrega repetida)."""
        if self.repository.exists_message(message.message_id):
            return False
        entry = ActivityLog(**message.model_dump())
        try:
            self.repository.add(entry)
        except IntegrityError:
            # Duas entregas simultâneas da mesma mensagem: o índice único barra a segunda.
            self.repository.rollback()
            if self.repository.exists_message(message.message_id):
                return False
            raise
        LOG_ENTRIES_CREATED.labels(origin="rabbitmq").inc()
        return True

    def list_logs(self, filters: LogFilters) -> list[ActivityLog]:
        return self.repository.get_all(filters)

    def count_logs(self, filters: LogFilters) -> int:
        return self.repository.count(filters)

    def get_log(self, log_id: UUID) -> ActivityLog:
        entry = self.repository.get_by_id(log_id)
        if entry is None:
            raise LogNotFoundError()
        return entry

    def update_log(self, log_id: UUID, payload: LogUpdate) -> ActivityLog:
        entry = self.get_log(log_id)
        if entry.archived_at is not None:
            raise LogConflictError("Archived log entry cannot be modified")
        changes = payload.model_dump(exclude_unset=True)
        if not changes:
            return entry
        updated = self.repository.update(entry, changes)
        log_event("LOG ENTRY UPDATED", log_id=log_id, changed_fields=sorted(changes))
        return updated

    def archive_log(self, log_id: UUID) -> ActivityLog:
        entry = self.get_log(log_id)
        if entry.archived_at is not None:
            raise LogConflictError("Log entry is already archived")
        archived = self.repository.update(entry, {"archived_at": datetime.now(timezone.utc)})
        log_event("LOG ENTRY ARCHIVED", log_id=log_id)
        return archived
