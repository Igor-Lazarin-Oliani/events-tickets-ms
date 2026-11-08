from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Configuração lida de DATABASE_URL, RABBITMQ_URL, PORT e SERVICE_NAME."""

    database_url: str = "postgresql+psycopg2://events_user:events_pass@events-db:5432/events_db"
    rabbitmq_url: str = "amqp://events_tickets:events_tickets_pass@rabbitmq:5672/%2F"
    port: int = 8000
    service_name: str = "events-service"


settings = Settings()
