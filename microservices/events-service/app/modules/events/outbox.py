import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Callable

import pika
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.telemetry import MESSAGES_PUBLISHED, OUTBOX_PENDING, log_event
from app.modules.events.models import OutboxMessage
from app.modules.events.repository import EventRepository

EXCHANGE = "events.exchange"
BATCH_SIZE = 50
PERSISTENT_DELIVERY = 2


def open_rabbitmq_connection() -> pika.BlockingConnection:
    parameters = pika.URLParameters(settings.rabbitmq_url)
    parameters.connection_attempts = 1
    parameters.socket_timeout = 3
    parameters.blocked_connection_timeout = 5
    return pika.BlockingConnection(parameters)


class OutboxPublisher:
    """Publica no RabbitMQ as mensagens pendentes da outbox, em segundo plano.

    A entrega é "ao menos uma vez": uma falha no meio do lote reenvia as mensagens do lote,
    e o consumidor é idempotente.
    """

    def __init__(
        self,
        session_factory: Callable[[], Session],
        connection_factory: Callable[[], Any] = open_rabbitmq_connection,
        poll_seconds: float = 1.0,
        retry_seconds: float = 5.0,
    ) -> None:
        self.session_factory = session_factory
        self.connection_factory = connection_factory
        self.poll_seconds = poll_seconds
        self.retry_seconds = retry_seconds
        self._stop_requested = threading.Event()
        self._thread = threading.Thread(target=self._run, name="outbox-publisher", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop_requested.set()
        self._thread.join(timeout=5)

    def publish_pending(self) -> int:
        with self.session_factory() as db:
            messages = EventRepository(db).get_pending_messages(BATCH_SIZE)
            OUTBOX_PENDING.set(len(messages))
            if not messages:
                return 0

            # A conexão é aberta por lote porque cancelamentos são raros.
            with self.connection_factory() as connection:
                channel = connection.channel()
                channel.exchange_declare(exchange=EXCHANGE, exchange_type="topic", durable=True)
                channel.confirm_delivery()
                for message in messages:
                    self._publish(channel, message)

            db.commit()

        OUTBOX_PENDING.set(0)
        for message in messages:
            MESSAGES_PUBLISHED.labels(routing_key=message.routing_key).inc()
            log_event(
                "EVENT MESSAGE PUBLISHED",
                correlation_id=message.payload.get("correlation_id", "-"),
                routing_key=message.routing_key,
                event_id=message.payload.get("event_id"),
                message_id=message.id,
            )
        return len(messages)

    def _publish(self, channel: Any, message: OutboxMessage) -> None:
        # "mandatory" faz o RabbitMQ recusar a mensagem se ainda não houver fila ligada.
        channel.basic_publish(
            exchange=EXCHANGE,
            routing_key=message.routing_key,
            body=json.dumps(message.payload),
            properties=pika.BasicProperties(
                content_type="application/json",
                delivery_mode=PERSISTENT_DELIVERY,
                message_id=str(message.id),
                correlation_id=message.payload.get("correlation_id"),
            ),
            mandatory=True,
        )
        message.published_at = datetime.now(timezone.utc)

    def _run(self) -> None:
        wait_seconds = self.poll_seconds
        while not self._stop_requested.wait(wait_seconds):
            try:
                self.publish_pending()
                wait_seconds = self.poll_seconds
            # A thread precisa sobreviver a qualquer falha do broker ou do banco.
            except Exception as error:  # noqa: BLE001
                wait_seconds = self.retry_seconds
                log_event(
                    "EVENT MESSAGE PUBLISH FAILED",
                    level=logging.WARNING,
                    reason=str(error) or type(error).__name__,
                    retry_in_seconds=self.retry_seconds,
                )
