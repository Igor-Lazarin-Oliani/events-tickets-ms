from typing import Any, Callable, Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Iterator[Session]:
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    # Sem o bloco "with", o lifespan não roda e o PostgreSQL não é acessado.
    yield TestClient(app)
    app.dependency_overrides.clear()
    engine.dispose()


@pytest.fixture
def create_event(client: TestClient) -> Callable[..., dict[str, Any]]:
    def _create(max_capacity: int = 2, **overrides: Any) -> dict[str, Any]:
        payload = {
            "title": "Workshop Docker",
            "category": "WORKSHOP",
            "modality": "ONLINE",
            "location": "https://example.com/live",
            "start_at": "2026-11-20T08:00:00-04:00",
            "end_at": "2026-11-20T18:00:00-04:00",
            "max_capacity": max_capacity,
            **overrides,
        }
        response = client.post("/events", json=payload)
        assert response.status_code == 201, response.text
        return response.json()

    return _create
