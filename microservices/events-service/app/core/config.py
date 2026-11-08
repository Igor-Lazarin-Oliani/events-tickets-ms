from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Configuração lida das variáveis de ambiente DATABASE_URL, PORT e SERVICE_NAME."""

    database_url: str = "postgresql+psycopg2://events_user:events_pass@events-db:5432/events_db"
    port: int = 8000
    service_name: str = "events-service"


settings = Settings()
