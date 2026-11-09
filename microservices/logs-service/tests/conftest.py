from typing import Any, Callable, Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app

EVENT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
TICKET_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"


@pytest.fixture
def session_factory() -> Iterator[Callable[[], Session]]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    yield sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def client(session_factory: Callable[[], Session]) -> Iterator[TestClient]:
    def override_get_db() -> Iterator[Session]:
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    # Sem o bloco "with", o lifespan não roda, e PostgreSQL e RabbitMQ não são acessados.
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def create_log(client: TestClient) -> Callable[..., dict[str, Any]]:
    def _create(**overrides: Any) -> dict[str, Any]:
        payload = {
            "action": "incident.reported",
            "entity_type": "event",
            "entity_id": EVENT_ID,
            "level": "WARNING",
            "message": "Projetor com defeito",
            **overrides,
        }
        response = client.post("/logs", json=payload)
        assert response.status_code == 201, response.text
        return response.json()

    return _create
