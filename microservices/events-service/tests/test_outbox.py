import json
import uuid

import pytest
from sqlalchemy import select

from app.modules.events.models import OutboxMessage
from app.modules.events.outbox import EXCHANGE, OutboxPublisher


class FakeChannel:
    def __init__(self, fail_on_publish_number=None):
        self.published = []
        self.confirmed = False
        self.fail_on_publish_number = fail_on_publish_number

    def exchange_declare(self, exchange, exchange_type, durable):
        assert (exchange, exchange_type, durable) == (EXCHANGE, "topic", True)

    def confirm_delivery(self):
        self.confirmed = True

    def basic_publish(self, exchange, routing_key, body, properties, mandatory):
        if len(self.published) + 1 == self.fail_on_publish_number:
            raise RuntimeError("unroutable")
        assert mandatory is True
        assert properties.delivery_mode == 2
        self.published.append((routing_key, json.loads(body)))


class FakeConnection:
    def __init__(self, channel):
        self._channel = channel

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def channel(self):
        return self._channel


def all_messages(session_factory):
    with session_factory() as db:
        return list(db.scalars(select(OutboxMessage)))


def pending_messages(session_factory):
    return [m for m in all_messages(session_factory) if m.published_at is None]


def publisher_for(session_factory, channel):
    return OutboxPublisher(session_factory, connection_factory=lambda: FakeConnection(channel))


def test_cancelling_event_queues_one_message(client, create_event, session_factory):
    event = create_event()

    client.put(f"/events/{event['id']}", json={"status": "CANCELLED"})
    client.put(f"/events/{event['id']}", json={"status": "CANCELLED"})

    messages = all_messages(session_factory)
    assert [m.routing_key for m in messages] == ["event.cancelled"]
    assert messages[0].payload["event_id"] == event["id"]
    assert messages[0].payload["event_type"] == "event.cancelled"


def test_correlation_id_is_stored_in_message(client, create_event, session_factory):
    event = create_event()

    client.put(
        f"/events/{event['id']}",
        json={"status": "CANCELLED"},
        headers={"X-Correlation-Id": "demo-cancel"},
    )

    assert all_messages(session_factory)[0].payload["correlation_id"] == "demo-cancel"


@pytest.mark.parametrize("changes", [{"title": "Outro"}, {"status": "FINISHED"}])
def test_other_updates_do_not_queue_messages(client, create_event, session_factory, changes):
    event = create_event()

    client.put(f"/events/{event['id']}", json=changes)

    assert all_messages(session_factory) == []


def test_rejected_cancellation_does_not_queue_message(client, create_event, session_factory):
    event = create_event()

    response = client.put(
        f"/events/{event['id']}",
        json={"status": "CANCELLED", "end_at": "2026-11-19T08:00:00-04:00"},
    )

    assert response.status_code == 422
    assert all_messages(session_factory) == []


def test_deleting_event_queues_message(client, create_event, session_factory):
    event = create_event()

    client.delete(f"/events/{event['id']}")

    messages = all_messages(session_factory)
    assert [m.routing_key for m in messages] == ["event.deleted"]
    assert messages[0].payload["event_id"] == event["id"]


def test_deleting_unknown_event_queues_nothing(client, session_factory):
    assert client.delete(f"/events/{uuid.uuid4()}").status_code == 404
    assert all_messages(session_factory) == []


@pytest.mark.parametrize("new_status", ["PUBLISHED", "SOLD_OUT", "FINISHED"])
def test_cancelled_event_cannot_be_reopened(client, create_event, new_status):
    event = create_event()
    client.put(f"/events/{event['id']}", json={"status": "CANCELLED"})

    response = client.put(f"/events/{event['id']}", json={"status": new_status})

    assert response.status_code == 409
    assert client.get(f"/events/{event['id']}").json()["status"] == "CANCELLED"


def test_cancelled_event_still_accepts_other_fields(client, create_event):
    event = create_event()
    client.put(f"/events/{event['id']}", json={"status": "CANCELLED"})

    updated = client.put(f"/events/{event['id']}", json={"title": "Novo título"})

    assert updated.status_code == 200
    assert updated.json()["status"] == "CANCELLED"


def test_publisher_sends_pending_messages_and_marks_them(client, create_event, session_factory):
    event = create_event()
    client.delete(f"/events/{event['id']}")
    channel = FakeChannel()

    published = publisher_for(session_factory, channel).publish_pending()

    assert published == 1
    assert channel.confirmed is True
    assert channel.published[0][0] == "event.deleted"
    assert channel.published[0][1]["event_id"] == event["id"]
    assert pending_messages(session_factory) == []


def test_publisher_does_not_resend_published_messages(client, create_event, session_factory):
    client.delete(f"/events/{create_event()['id']}")
    channel = FakeChannel()
    publisher = publisher_for(session_factory, channel)

    publisher.publish_pending()

    assert publisher.publish_pending() == 0
    assert len(channel.published) == 1


def test_publisher_does_not_connect_without_pending_messages(session_factory):
    def fail_if_called():
        raise AssertionError("não deveria abrir conexão")

    assert OutboxPublisher(session_factory, fail_if_called).publish_pending() == 0


def test_broker_unavailable_keeps_messages_pending(client, create_event, session_factory):
    client.delete(f"/events/{create_event()['id']}")

    def broker_down():
        raise ConnectionError("broker down")

    with pytest.raises(ConnectionError):
        OutboxPublisher(session_factory, broker_down).publish_pending()

    assert len(pending_messages(session_factory)) == 1


def test_failure_in_batch_keeps_whole_batch_pending(client, create_event, session_factory):
    client.delete(f"/events/{create_event()['id']}")
    client.delete(f"/events/{create_event()['id']}")
    channel = FakeChannel(fail_on_publish_number=2)

    with pytest.raises(RuntimeError):
        publisher_for(session_factory, channel).publish_pending()

    assert len(pending_messages(session_factory)) == 2
