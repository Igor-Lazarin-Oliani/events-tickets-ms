import uuid

import pytest

from tests.conftest import EVENT_ID, TICKET_ID

UNKNOWN_ID = str(uuid.uuid4())


def test_create_manual_log_starts_as_new(create_log):
    log = create_log()

    assert log["source"] == "manual"
    assert log["status"] == "NEW"
    assert log["message_id"] is None
    assert log["archived_at"] is None
    assert log["occurred_at"] is not None


@pytest.mark.parametrize(
    "overrides",
    [
        {"action": "sem-ponto"},
        {"message": ""},
        {"level": "DEBUG"},
        {"entity_type": None},
        {"occurred_at": "2026-11-20T08:00:00"},
        {"message_id": str(uuid.uuid4())},
    ],
    ids=[
        "acao-sem-entidade",
        "mensagem-vazia",
        "nivel-desconhecido",
        "entity-id-sem-tipo",
        "data-sem-fuso",
        "message-id-e-do-consumidor",
    ],
)
def test_create_rejects_invalid_payload(client, overrides):
    payload = {
        "action": "incident.reported",
        "entity_type": "event",
        "entity_id": EVENT_ID,
        "message": "Projetor com defeito",
        **overrides,
    }

    assert client.post("/logs", json=payload).status_code == 422


def test_get_returns_log_and_unknown_returns_404(client, create_log):
    log = create_log()

    assert client.get(f"/logs/{log['id']}").json()["id"] == log["id"]
    assert client.get(f"/logs/{UNKNOWN_ID}").status_code == 404


def test_list_filters_by_entity(client, create_log):
    ticket_log = create_log(entity_type="ticket", entity_id=TICKET_ID, action="note.added")
    create_log()

    found = client.get("/logs", params={"entity_type": "ticket", "entity_id": TICKET_ID}).json()

    assert [log["id"] for log in found] == [ticket_log["id"]]


def test_list_filters_by_level_and_action(client, create_log):
    error_log = create_log(level="ERROR", action="incident.escalated")
    create_log(level="INFO")

    found = client.get("/logs", params={"level": "ERROR", "action": "incident.escalated"}).json()

    assert [log["id"] for log in found] == [error_log["id"]]


def test_list_orders_by_occurred_at(client, create_log):
    later = create_log(occurred_at="2026-11-20T10:00:00Z")
    earlier = create_log(occurred_at="2026-11-20T09:00:00Z")

    descending = [log["id"] for log in client.get("/logs").json()]
    ascending = [log["id"] for log in client.get("/logs", params={"order": "asc"}).json()]

    assert descending == [later["id"], earlier["id"]]
    assert ascending == [earlier["id"], later["id"]]


def test_list_paginates(client, create_log):
    for hour in range(3):
        create_log(occurred_at=f"2026-11-20T0{hour}:00:00Z")

    page = client.get("/logs", params={"limit": 2, "offset": 2, "order": "asc"}).json()

    assert len(page) == 1
    assert page[0]["occurred_at"].startswith("2026-11-20T02:00:00")


def test_update_changes_only_triage_fields(client, create_log):
    log = create_log()

    updated = client.put(
        f"/logs/{log['id']}", json={"status": "REVIEWED", "notes": "Conferido"}
    ).json()

    assert (updated["status"], updated["notes"]) == ("REVIEWED", "Conferido")
    assert updated["message"] == log["message"]


@pytest.mark.parametrize(
    "changes",
    [{"message": "Outra coisa"}, {"action": "note.added"}, {"level": "ERROR"}, {"status": None}],
    ids=["mensagem", "acao", "nivel", "status-nulo"],
)
def test_update_rejects_immutable_fields(client, create_log, changes):
    log = create_log()

    assert client.put(f"/logs/{log['id']}", json=changes).status_code == 422


def test_update_accepts_null_notes(client, create_log):
    log = create_log(notes="Anotação")

    updated = client.put(f"/logs/{log['id']}", json={"notes": None}).json()

    assert updated["notes"] is None


def test_delete_archives_and_hides_from_list(client, create_log):
    log = create_log()

    archived = client.delete(f"/logs/{log['id']}")

    assert archived.status_code == 200
    assert archived.json()["archived_at"] is not None
    assert client.get("/logs").json() == []
    assert [entry["id"] for entry in client.get("/logs", params={"include_archived": True}).json()] == [
        log["id"]
    ]
    assert client.get(f"/logs/{log['id']}").status_code == 200


def test_archived_log_cannot_be_archived_or_updated_again(client, create_log):
    log = create_log()
    client.delete(f"/logs/{log['id']}")

    repeated = client.delete(f"/logs/{log['id']}")
    updated = client.put(f"/logs/{log['id']}", json={"status": "RESOLVED"})

    assert (repeated.status_code, repeated.json()) == (409, {"detail": "Log entry is already archived"})
    assert updated.status_code == 409


def test_update_and_delete_unknown_log_return_404(client):
    assert client.put(f"/logs/{UNKNOWN_ID}", json={"status": "REVIEWED"}).status_code == 404
    assert client.delete(f"/logs/{UNKNOWN_ID}").status_code == 404


def test_correlation_id_is_returned_to_caller(client):
    response = client.get("/logs", headers={"X-Correlation-Id": "demo-123"})

    assert response.headers["X-Correlation-Id"] == "demo-123"


def test_manual_log_inherits_request_correlation_id(client):
    payload = {"action": "note.added", "message": "Anotação"}

    from_header = client.post("/logs", json=payload, headers={"X-Correlation-Id": "demo-456"})
    from_body = client.post(
        "/logs",
        json={**payload, "correlation_id": "corpo"},
        headers={"X-Correlation-Id": "demo-456"},
    )

    assert from_header.json()["correlation_id"] == "demo-456"
    assert from_body.json()["correlation_id"] == "corpo"


def test_health_reports_database_up(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "logs-service", "database": "up"}


def test_metrics_exposes_created_entries(client, create_log):
    create_log()

    body = client.get("/metrics").text

    assert 'logs_entries_created_total{origin="api"}' in body


def test_swagger_documents_all_routes(client):
    paths = client.get("/docs/logs/openapi.json").json()["paths"]

    assert {"/logs", "/logs/{id}", "/health", "/metrics"} <= set(paths)
    assert {"get", "put", "delete"} <= set(paths["/logs/{id}"])
    assert {"get", "post"} <= set(paths["/logs"])
