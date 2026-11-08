import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from app.core.telemetry import SPOT_OPERATIONS, correlation_id_var, log_event
from app.modules.events.models import Event, EventStatus, OutboxMessage
from app.modules.events.repository import EventRepository
from app.modules.events.schemas import EventCreate, EventUpdate

ROUTING_KEY_EVENT_CANCELLED = "event.cancelled"
ROUTING_KEY_EVENT_DELETED = "event.deleted"


class EventDomainError(Exception):
    status_code = 400

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class EventNotFoundError(EventDomainError):
    status_code = 404

    def __init__(self) -> None:
        super().__init__("Event not found")


class EventConflictError(EventDomainError):
    status_code = 409


class EventValidationError(EventDomainError):
    status_code = 422


def _as_aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _build_event_message(routing_key: str, event_id: UUID) -> OutboxMessage:
    message_id = uuid4()
    return OutboxMessage(
        id=message_id,
        routing_key=routing_key,
        payload={
            "message_id": str(message_id),
            "event_type": routing_key,
            "event_id": str(event_id),
            "occurred_at": datetime.now(timezone.utc).isoformat(),
            "correlation_id": correlation_id_var.get(),
        },
    )


def _log_message_queued(message: OutboxMessage) -> None:
    log_event(
        "EVENT MESSAGE QUEUED",
        routing_key=message.routing_key,
        event_id=message.payload["event_id"],
        message_id=message.id,
    )


class EventService:
    def __init__(self, repository: EventRepository) -> None:
        self.repository = repository

    def create_event(self, payload: EventCreate) -> Event:
        event = Event(
            **payload.model_dump(),
            available_spots=payload.max_capacity,
            status=EventStatus.PUBLISHED,
        )
        return self.repository.create(event)

    def list_events(
        self, category: Optional[str] = None, status: Optional[EventStatus] = None
    ) -> list[Event]:
        return self.repository.get_all(category=category, status=status)

    def get_event(self, event_id: UUID) -> Event:
        event = self.repository.get_by_id(event_id)
        if event is None:
            raise EventNotFoundError()
        return event

    def update_event(self, event_id: UUID, payload: EventUpdate) -> Event:
        event = self.repository.get_by_id_for_update(event_id)
        if event is None:
            raise EventNotFoundError()

        changes = payload.model_dump(exclude_unset=True)
        start_at = _as_aware(changes.get("start_at", event.start_at))
        end_at = _as_aware(changes.get("end_at", event.end_at))
        if end_at <= start_at:
            raise EventValidationError("end_at must be after start_at")

        new_capacity = changes.get("max_capacity", event.max_capacity)
        occupied_spots = event.max_capacity - event.available_spots
        if new_capacity < occupied_spots:
            raise EventConflictError(
                f"max_capacity cannot be lower than the {occupied_spots} occupied spots"
            )
        available_spots = new_capacity - occupied_spots

        previous_status = event.status
        status = changes.get("status", previous_status)
        # Terminal: reabrir permitiria que uma mensagem atrasada cancelasse ingressos novos.
        if previous_status == EventStatus.CANCELLED and status != EventStatus.CANCELLED:
            raise EventConflictError("Cancelled event cannot be reopened")

        if status == EventStatus.PUBLISHED and available_spots == 0:
            status = EventStatus.SOLD_OUT
        elif status == EventStatus.SOLD_OUT and available_spots > 0:
            status = EventStatus.PUBLISHED

        changes.update(available_spots=available_spots, status=status)
        message = None
        if status == EventStatus.CANCELLED and previous_status != EventStatus.CANCELLED:
            message = _build_event_message(ROUTING_KEY_EVENT_CANCELLED, event_id)

        updated = self.repository.update(event, changes, message)
        if message is not None:
            _log_message_queued(message)
        return updated

    def delete_event(self, event_id: UUID) -> None:
        message = _build_event_message(ROUTING_KEY_EVENT_DELETED, event_id)
        if not self.repository.delete(event_id, message):
            raise EventNotFoundError()
        _log_message_queued(message)

    def reserve_spot(self, event_id: UUID) -> Event:
        event = self.repository.reserve_spot(event_id)
        if event is not None:
            SPOT_OPERATIONS.labels(operation="reserve", result="success").inc()
            log_event(
                "EVENT SPOT RESERVED",
                event_id=event.id,
                available_spots=event.available_spots,
                status=event.status.value,
            )
            return event

        current = self.get_event(event_id)
        SPOT_OPERATIONS.labels(operation="reserve", result="conflict").inc()
        log_event(
            "EVENT SPOT REJECTED",
            level=logging.WARNING,
            event_id=event_id,
            available_spots=current.available_spots,
            status=current.status.value,
        )
        if current.available_spots <= 0:
            raise EventConflictError("Event is sold out")
        raise EventConflictError("Event is not open for registrations")

    def release_spot(self, event_id: UUID) -> Event:
        event = self.repository.release_spot(event_id)
        if event is not None:
            SPOT_OPERATIONS.labels(operation="release", result="success").inc()
            log_event(
                "EVENT SPOT RELEASED",
                event_id=event.id,
                available_spots=event.available_spots,
                status=event.status.value,
            )
            return event

        current = self.get_event(event_id)
        SPOT_OPERATIONS.labels(operation="release", result="at_capacity").inc()
        log_event(
            "EVENT SPOT RELEASE IGNORED",
            level=logging.WARNING,
            event_id=event_id,
            available_spots=current.available_spots,
            reason="event already at max_capacity",
        )
        return current
