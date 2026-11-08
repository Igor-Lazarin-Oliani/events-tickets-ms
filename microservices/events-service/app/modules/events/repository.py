from typing import Any, Optional
from uuid import UUID

from sqlalchemy import case, delete, select, update
from sqlalchemy.orm import Session

from app.modules.events.models import Event, EventStatus, OutboxMessage


class EventRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def create(self, event: Event) -> Event:
        self.db.add(event)
        self.db.commit()
        self.db.refresh(event)
        return event

    def get_all(
        self, category: Optional[str] = None, status: Optional[EventStatus] = None
    ) -> list[Event]:
        query = select(Event).order_by(Event.created_at.desc())
        if category is not None:
            query = query.where(Event.category == category)
        if status is not None:
            query = query.where(Event.status == status)
        return list(self.db.scalars(query))

    def get_by_id(self, event_id: UUID) -> Optional[Event]:
        return self.db.get(Event, event_id)

    def get_by_id_for_update(self, event_id: UUID) -> Optional[Event]:
        """Trava a linha até o commit, para a alteração de capacidade não concorrer com reservas."""
        query = (
            select(Event)
            .where(Event.id == event_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return self.db.scalar(query)

    def update(
        self, event: Event, changes: dict[str, Any], message: Optional[OutboxMessage] = None
    ) -> Event:
        for field_name, value in changes.items():
            setattr(event, field_name, value)
        if message is not None:
            self.db.add(message)
        self.db.commit()
        self.db.refresh(event)
        return event

    def delete(self, event_id: UUID, message: OutboxMessage) -> bool:
        result = self.db.execute(delete(Event).where(Event.id == event_id))
        if result.rowcount == 0:
            self.db.rollback()
            return False
        self.db.add(message)
        self.db.commit()
        return True

    def get_pending_messages(self, limit: int) -> list[OutboxMessage]:
        query = (
            select(OutboxMessage)
            .where(OutboxMessage.published_at.is_(None))
            .order_by(OutboxMessage.created_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        return list(self.db.scalars(query))

    def reserve_spot(self, event_id: UUID) -> Optional[Event]:
        """Reserva em um único UPDATE condicional; retorna None se a vaga não pôde ser reservada."""
        statement = (
            update(Event)
            .where(
                Event.id == event_id,
                Event.status == EventStatus.PUBLISHED,
                Event.available_spots > 0,
            )
            .values(
                available_spots=Event.available_spots - 1,
                # No SET, available_spots ainda é o valor anterior ao decremento.
                status=case(
                    (Event.available_spots == 1, EventStatus.SOLD_OUT.value),
                    else_=Event.status,
                ),
            )
        )
        return self._apply_conditional_update(event_id, statement)

    def release_spot(self, event_id: UUID) -> Optional[Event]:
        """Devolve em um único UPDATE condicional; retorna None se nada foi alterado."""
        statement = (
            update(Event)
            .where(Event.id == event_id, Event.available_spots < Event.max_capacity)
            .values(
                available_spots=Event.available_spots + 1,
                status=case(
                    (Event.status == EventStatus.SOLD_OUT, EventStatus.PUBLISHED.value),
                    else_=Event.status,
                ),
            )
        )
        return self._apply_conditional_update(event_id, statement)

    def _apply_conditional_update(self, event_id: UUID, statement: Any) -> Optional[Event]:
        result = self.db.execute(statement.execution_options(synchronize_session=False))
        self.db.commit()
        if result.rowcount == 0:
            return None
        return self.db.scalar(
            select(Event).where(Event.id == event_id).execution_options(populate_existing=True)
        )
