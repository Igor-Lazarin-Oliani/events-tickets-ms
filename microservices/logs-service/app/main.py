from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from prometheus_fastapi_instrumentator import Instrumentator
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal, get_db, init_db
from app.core.telemetry import TelemetryMiddleware, configure_logging, log_event
from app.modules.logs.consumer import ActivityConsumer
from app.modules.logs.router import router as logs_router
from app.modules.logs.service import LogDomainError

configure_logging()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    init_db()
    # Em thread separada: a API HTTP sobe e responde mesmo com o broker indisponível.
    consumer = ActivityConsumer(SessionLocal)
    consumer.start()
    log_event("STARTUP", status="ready", port=settings.port)
    yield
    consumer.stop()


app = FastAPI(
    title="events-tickets-ms - Logs Microservice API",
    description=(
        "Registro de atividades da plataforma events-tickets-ms. Os registros automáticos chegam "
        "do events-tickets-service pelo RabbitMQ; a API permite criar registros manuais, "
        "consultar, fazer a triagem e arquivar."
    ),
    version="2.0.0",
    # Caminhos públicos: o gateway encaminha /docs/logs sem reescrever a URL.
    docs_url="/docs/logs",
    openapi_url="/docs/logs/openapi.json",
    redoc_url=None,
    openapi_tags=[
        {"name": "Logs (Registro de atividades)", "description": "CRUD dos registros."},
        {"name": "Observability", "description": "Saúde e métricas do serviço."},
    ],
    lifespan=lifespan,
)

app.add_middleware(TelemetryMiddleware)
app.include_router(logs_router)


class HealthResponse(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={"example": {"status": "ok", "service": "logs-service", "database": "up"}}
    )

    status: str
    service: str
    database: str


@app.exception_handler(LogDomainError)
def handle_domain_error(_: Request, error: LogDomainError) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content={"detail": error.detail})


@app.get(
    "/health",
    response_model=HealthResponse,
    tags=["Observability"],
    summary="Verifica a saúde do serviço",
    description=(
        "Confirma que a API está no ar e que o banco responde. "
        "Rota interna; pelo gateway, use `/health/logs`."
    ),
    response_description="Serviço e banco disponíveis.",
    responses={503: {"model": HealthResponse, "description": "Banco de dados indisponível."}},
)
def health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "service": settings.service_name, "database": "down"},
        )
    return {"status": "ok", "service": settings.service_name, "database": "up"}


Instrumentator(excluded_handlers=["/metrics", "/health"]).instrument(app).expose(
    app,
    endpoint="/metrics",
    tags=["Observability"],
    summary="Expõe as métricas no formato Prometheus",
    description="Rota interna; pelo gateway, use `/metrics/logs`.",
)
