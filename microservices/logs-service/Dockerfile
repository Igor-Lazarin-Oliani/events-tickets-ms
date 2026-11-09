FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

# Copiado antes do código para reaproveitar o cache das dependências.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd --system --no-create-home appuser
USER appuser

EXPOSE 8000

# O log de acesso do uvicorn é desligado porque o [TELEMETRY] já registra cada requisição.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --no-access-log"]
