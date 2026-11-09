import json
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.modules.logs.consumer import ActivityConsumer
from app.modules.logs.models import ActivityLog
from tests.conftest import EVENT_ID, TICKET_ID


class FakeChannel:
    def __init__(self):
        self.acked = []
        self.nacked = []

    def basic_ack(self, delivery_tag):
        self.acked.append(delivery_tag)

    def basic_nack(self, delivery_tag, requeue):
        self.nacked.append((delivery_tag, requeue))


def activity_message(**overrides):
    return {
        "message_id": str(uuid.uuid4()),
        "action": "ticket.issued",
        "entity_type": "ticket",
        "entity_id": TICKET_ID,
        "level": "INFO",
        "message": "Ticket EVT-2026-A8F9K2 issued",
        "data": {"ticket_code": "EVT-2026-A8F9K2", "event_id": EVENT_ID, "status": "CONFIRMED"},
        "source": "events-tickets-service",
        "occurred_at": "2026-11-20T12:00:00+00:00",
        "correlation_id": "demo-123",
        **overrides,
    }


def deliver(consumer, body, routing_key="ticket.issued", delivery_tag=1):
    channel = FakeChannel()
    method = SimpleNamespace(routing_key=routing_key, delivery_tag=delivery_tag)
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    result = consumer.handle_delivery(channel, method, raw)
    return result, channel


def stored_logs(session_factory):
    with session_factory() as db:
        return list(db.scalars(select(ActivityLog)))


@pytest.fixture
def consumer(session_factory):
    return ActivityConsumer(session_factory, connection_factory=None, retry_seconds=0)


def test_valid_message_is_stored_and_acked(consumer, session_factory):
    message = activity_message()

    result, channel = deliver(consumer, message)

    assert result == "processed"
    assert channel.acked == [1]
    [log] = stored_logs(session_factory)
    assert str(log.message_id) == message["message_id"]
    assert (log.action, log.entity_type, log.correlation_id) == (
        "ticket.issued",
        "ticket",
        "demo-123",
    )


def test_repeated_delivery_is_acked_without_duplicating(consumer, session_factory):
    message = activity_message()

    deliver(consumer, message)
    result, channel = deliver(consumer, message, delivery_tag=2)

    assert result == "duplicate"
    assert channel.acked == [2]
    assert len(stored_logs(session_factory)) == 1


def test_archived_log_is_not_recreated_by_redelivery(client, consumer, session_factory):
    message = activity_message()
    deliver(consumer, message)
    log_id = stored_logs(session_factory)[0].id
    client.delete(f"/logs/{log_id}")

    result, _ = deliver(consumer, message, delivery_tag=2)

    assert result == "duplicate"
    assert len(stored_logs(session_factory)) == 1


@pytest.mark.parametrize(
    "body",
    [
        b"nao-e-json",
        activity_message(message_id="abc"),
        activity_message(occurred_at="2026-11-20T12:00:00"),
        {"action": "ticket.issued"},
    ],
    ids=["json-invalido", "message-id-invalido", "data-sem-fuso", "campos-faltando"],
)
def test_invalid_message_goes_to_dead_letter_queue(consumer, session_factory, body):
    result, channel = deliver(consumer, body)

    assert result == "rejected"
    assert channel.nacked == [(1, False)]
    assert stored_logs(session_factory) == []


def test_routing_key_must_match_action(consumer, session_factory):
    result, channel = deliver(consumer, activity_message(), routing_key="ticket.cancelled")

    assert result == "rejected"
    assert channel.nacked == [(1, False)]


def test_database_failure_requeues_message(session_factory):
    def broken_session():
        raise RuntimeError("database down")

    consumer = ActivityConsumer(broken_session, connection_factory=None, retry_seconds=0)

    result, channel = deliver(consumer, activity_message())

    assert result == "retried"
    assert channel.nacked == [(1, True)]
    assert channel.acked == []


def test_messages_appear_in_entity_history(client, consumer):
    deliver(consumer, activity_message(occurred_at="2026-11-20T12:00:00+00:00"))
    deliver(
        consumer,
        activity_message(action="ticket.checked_in", occurred_at="2026-11-20T13:00:00+00:00"),
        routing_key="ticket.checked_in",
    )

    history = client.get(
        "/logs", params={"entity_type": "ticket", "entity_id": TICKET_ID, "order": "asc"}
    ).json()

    assert [entry["action"] for entry in history] == ["ticket.issued", "ticket.checked_in"]
