import logging
import threading
from typing import Any, Callable, Optional

import pika
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.telemetry import MESSAGES_CONSUMED, correlation_id_var, log_event
from app.modules.logs.repository import LogRepository
from app.modules.logs.schemas import ActivityMessage
from app.modules.logs.service import LogService

# Exchange em que o events-service e o tickets-service publicam as atividades (D20, D34).
EXCHANGE = "activities.exchange"
QUEUE = "logs.activity"
DEAD_LETTER_EXCHANGE = "logs.activity.dlx"
DEAD_LETTER_QUEUE = "logs.activity.dlq"
BINDING_KEYS = ("event.*", "ticket.*")
PREFETCH = 10


def open_rabbitmq_connection() -> pika.BlockingConnection:
    parameters = pika.URLParameters(settings.rabbitmq_url)
    parameters.connection_attempts = 1
    parameters.socket_timeout = 3
    parameters.heartbeat = 30
    return pika.BlockingConnection(parameters)


class ActivityConsumer:
    """Consome a fila logs.activity em segundo plano e grava cada mensagem uma única vez.

    A entrega é "ao menos uma vez": a confirmação (ack) só sai depois da gravação, e o message_id
    único descarta repetições. Mensagem inválida vai para a DLQ; falha do banco devolve a
    mensagem para a fila.
    """

    def __init__(
        self,
        session_factory: Callable[[], Session],
        connection_factory: Callable[[], Any] = open_rabbitmq_connection,
        retry_seconds: float = settings.rabbitmq_retry_seconds,
    ) -> None:
        self.session_factory = session_factory
        self.connection_factory = connection_factory
        self.retry_seconds = retry_seconds
        self._stop_requested = threading.Event()
        self._connection: Optional[Any] = None
        self._channel: Optional[Any] = None
        self._thread = threading.Thread(target=self._run, name="activity-consumer", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop_requested.set()
        connection = self._connection
        if connection is not None and connection.is_open:
            try:
                # O BlockingConnection não é thread-safe: o pedido de parada entra na fila dele.
                connection.add_callback_threadsafe(self._stop_consuming)
            except Exception:  # noqa: BLE001
                pass
        self._thread.join(timeout=5)

    def handle_delivery(self, channel: Any, method: Any, body: bytes) -> str:
        routing_key = method.routing_key
        message = self._parse(body, routing_key)
        if message is None:
            MESSAGES_CONSUMED.labels(routing_key=routing_key, result="rejected").inc()
            log_event("ACTIVITY MESSAGE REJECTED", level=logging.WARNING, routing_key=routing_key)
            channel.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
            return "rejected"

        token = correlation_id_var.set(message.correlation_id or "-")
        try:
            return self._record(channel, method, message)
        finally:
            correlation_id_var.reset(token)

    def _record(self, channel: Any, method: Any, message: ActivityMessage) -> str:
        routing_key = method.routing_key
        try:
            with self.session_factory() as db:
                created = LogService(LogRepository(db)).record_message(message)
        except Exception as error:  # noqa: BLE001
            MESSAGES_CONSUMED.labels(routing_key=routing_key, result="retried").inc()
            log_event(
                "ACTIVITY MESSAGE RETRY",
                level=logging.WARNING,
                routing_key=routing_key,
                message_id=message.message_id,
                reason=str(error) or type(error).__name__,
            )
            # A espera evita um laço de reentrega enquanto o banco estiver indisponível.
            self._stop_requested.wait(self.retry_seconds)
            channel.basic_nack(delivery_tag=method.delivery_tag, requeue=True)
            return "retried"

        result = "processed" if created else "duplicate"
        MESSAGES_CONSUMED.labels(routing_key=routing_key, result=result).inc()
        log_event(
            "ACTIVITY LOGGED" if created else "ACTIVITY MESSAGE DUPLICATE",
            routing_key=routing_key,
            entity_id=message.entity_id,
            message_id=message.message_id,
        )
        channel.basic_ack(delivery_tag=method.delivery_tag)
        return result

    @staticmethod
    def _parse(body: bytes, routing_key: str) -> Optional[ActivityMessage]:
        try:
            message = ActivityMessage.model_validate_json(body)
        except ValidationError:
            return None
        # A routing key é a própria ação; divergência indica mensagem malformada.
        return message if message.action == routing_key else None

    def _run(self) -> None:
        while not self._stop_requested.is_set():
            try:
                self._consume()
            # A thread precisa sobreviver a qualquer falha do broker.
            except Exception as error:  # noqa: BLE001
                if self._stop_requested.is_set():
                    break
                log_event(
                    "RABBITMQ CONNECTION FAILED",
                    level=logging.WARNING,
                    reason=str(error) or type(error).__name__,
                    retry_in_seconds=self.retry_seconds,
                )
            finally:
                self._close()
            self._stop_requested.wait(self.retry_seconds)

    def _consume(self) -> None:
        self._connection = self.connection_factory()
        channel = self._connection.channel()
        self._channel = channel
        self._declare_topology(channel)
        channel.basic_qos(prefetch_count=PREFETCH)
        channel.basic_consume(
            queue=QUEUE,
            on_message_callback=lambda ch, method, _properties, body: self.handle_delivery(
                ch, method, body
            ),
        )
        log_event("RABBITMQ CONSUMER READY", queue=QUEUE, bindings=list(BINDING_KEYS))
        channel.start_consuming()

    @staticmethod
    def _declare_topology(channel: Any) -> None:
        channel.exchange_declare(exchange=EXCHANGE, exchange_type="topic", durable=True)
        channel.exchange_declare(
            exchange=DEAD_LETTER_EXCHANGE, exchange_type="fanout", durable=True
        )
        channel.queue_declare(queue=DEAD_LETTER_QUEUE, durable=True)
        channel.queue_bind(queue=DEAD_LETTER_QUEUE, exchange=DEAD_LETTER_EXCHANGE)
        channel.queue_declare(
            queue=QUEUE,
            durable=True,
            arguments={"x-dead-letter-exchange": DEAD_LETTER_EXCHANGE},
        )
        for routing_key in BINDING_KEYS:
            channel.queue_bind(queue=QUEUE, exchange=EXCHANGE, routing_key=routing_key)

    def _stop_consuming(self) -> None:
        if self._channel is not None:
            self._channel.stop_consuming()

    def _close(self) -> None:
        connection = self._connection
        self._connection = None
        self._channel = None
        if connection is not None and connection.is_open:
            try:
                connection.close()
            except Exception:  # noqa: BLE001
                pass
