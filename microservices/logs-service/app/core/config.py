from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Configuração lida de DATABASE_URL, RABBITMQ_URL, PORT e SERVICE_NAME."""

    database_url: str = "postgresql+psycopg2://logs_user:logs_pass@logs-db:5432/logs_db"
    rabbitmq_url: str = "amqp://events_tickets:events_tickets_pass@rabbitmq:5672/%2F"
    rabbitmq_retry_seconds: float = 5.0
    port: int = 8000
    service_name: str = "logs-service"


settings = Settings()
