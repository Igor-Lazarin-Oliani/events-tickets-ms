import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from app.core.telemetry import SPOT_OPERATIONS, log_event
from app.modules.events.models import Event, EventStatus
from app.modules.events.repository import EventRepository
from app.modules.events.schemas import EventCreate, EventUpdate


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

        status = changes.get("status", event.status)
        if status == EventStatus.PUBLISHED and available_spots == 0:
            status = EventStatus.SOLD_OUT
        elif status == EventStatus.SOLD_OUT and available_spots > 0:
            status = EventStatus.PUBLISHED

        changes.update(available_spots=available_spots, status=status)
        return self.repository.update(event, changes)

    def delete_event(self, event_id: UUID) -> None:
        if not self.repository.delete(event_id):
            raise EventNotFoundError()

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
