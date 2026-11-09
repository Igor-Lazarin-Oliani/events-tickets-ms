import logging
import time
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings

logger = logging.getLogger(settings.service_name)

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db(max_attempts: int = 30, delay_seconds: float = 1.0) -> None:
    """Cria as tabelas, tolerando o intervalo em que o PostgreSQL ainda recusa conexões."""
    for attempt in range(1, max_attempts + 1):
        try:
            Base.metadata.create_all(bind=engine)
            return
        except OperationalError:
            if attempt == max_attempts:
                raise
            logger.warning("[DATABASE] aguardando o banco (tentativa %s/%s)", attempt, max_attempts)
            time.sleep(delay_seconds)
