import json
import logging
import sys
import time
import uuid
from contextvars import ContextVar
from typing import Any

from prometheus_client import Counter
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import settings

CORRELATION_HEADER = "X-Correlation-Id"
MAX_CORRELATION_ID_LENGTH = 128
# Chamados a todo instante pelo healthcheck e por coletores; poluiriam a demonstração ao vivo.
UNLOGGED_PATHS = {"/health", "/metrics"}

logger = logging.getLogger(settings.service_name)
correlation_id_var: ContextVar[str] = ContextVar("correlation_id", default="-")

MESSAGES_CONSUMED = Counter(
    "logs_messages_consumed_total",
    "Mensagens de atividade consumidas do RabbitMQ, por routing key e resultado.",
    ["routing_key", "result"],
)
LOG_ENTRIES_CREATED = Counter(
    "logs_entries_created_total",
    "Registros gravados, por origem: rabbitmq (automáticos) ou api (manuais).",
    ["origin"],
)


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    # O consumidor já registra as falhas de conexão de forma resumida.
    logging.getLogger("pika").setLevel(logging.CRITICAL)


def log_event(tag: str, level: int = logging.INFO, **fields: Any) -> None:
    payload = {
        "service": settings.service_name,
        "correlation_id": correlation_id_var.get(),
        **fields,
    }
    logger.log(level, "[%s] %s", tag, json.dumps(payload, default=str, ensure_ascii=False))


class TelemetryMiddleware:
    """Registra cada requisição e propaga o X-Correlation-Id recebido do gateway ou do
    events-tickets-service."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        received_id = Headers(scope=scope).get(CORRELATION_HEADER)
        correlation_id = (received_id or str(uuid.uuid4()))[:MAX_CORRELATION_ID_LENGTH]
        token = correlation_id_var.set(correlation_id)
        started_at = time.perf_counter()
        status_code = 500

        async def send_with_correlation(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                MutableHeaders(scope=message)[CORRELATION_HEADER] = correlation_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_correlation)
        finally:
            if scope["path"] not in UNLOGGED_PATHS:
                route = scope.get("route")
                log_event(
                    "TELEMETRY",
                    method=scope["method"],
                    route=getattr(route, "path", scope["path"]),
                    status=status_code,
                    duration_ms=round((time.perf_counter() - started_at) * 1000, 2),
                )
            correlation_id_var.reset(token)
