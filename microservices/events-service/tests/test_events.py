import uuid

import pytest

UNKNOWN_ID = str(uuid.uuid4())


def reserve(client, event):
    return client.patch(f"/events/{event['id']}/reserve-spot")


def release(client, event):
    return client.patch(f"/events/{event['id']}/release-spot")


def test_create_starts_with_all_spots_available(create_event):
    event = create_event(max_capacity=5)

    assert event["available_spots"] == 5
    assert event["status"] == "PUBLISHED"


@pytest.mark.parametrize(
    "overrides",
    [
        {"max_capacity": 0},
        {"end_at": "2026-11-20T08:00:00-04:00"},
        {"start_at": "2026-11-20T08:00:00"},
    ],
    ids=["capacidade-zero", "fim-igual-ao-inicio", "data-sem-fuso"],
)
def test_create_rejects_invalid_payload(client, overrides):
    payload = {
        "title": "Evento",
        "modality": "ONLINE",
        "location": "Sala 1",
        "start_at": "2026-11-20T08:00:00-04:00",
        "end_at": "2026-11-20T18:00:00-04:00",
        "max_capacity": 2,
        **overrides,
    }

    assert client.post("/events", json=payload).status_code == 422


def test_list_filters_by_category_and_status(client, create_event):
    academic = create_event(category="ACADEMIC", max_capacity=1)
    create_event(category="SPORTS")
    reserve(client, academic)

    found = client.get("/events", params={"category": "ACADEMIC", "status": "SOLD_OUT"}).json()

    assert [event["id"] for event in found] == [academic["id"]]


def test_get_and_delete_unknown_event_return_404(client):
    assert client.get(f"/events/{UNKNOWN_ID}").status_code == 404
    assert client.delete(f"/events/{UNKNOWN_ID}").status_code == 404


def test_delete_removes_event(client, create_event):
    event = create_event()

    assert client.delete(f"/events/{event['id']}").status_code == 204
    assert client.get(f"/events/{event['id']}").status_code == 404


def test_last_reservation_marks_event_sold_out(client, create_event):
    event = create_event(max_capacity=2)

    first = reserve(client, event).json()
    second = reserve(client, event).json()

    assert (first["available_spots"], first["status"]) == (1, "PUBLISHED")
    assert (second["available_spots"], second["status"]) == (0, "SOLD_OUT")


def test_reserve_on_sold_out_event_returns_409(client, create_event):
    event = create_event(max_capacity=1)
    reserve(client, event)

    response = reserve(client, event)

    assert response.status_code == 409
    assert response.json() == {"detail": "Event is sold out"}


@pytest.mark.parametrize("closed_status", ["CANCELLED", "FINISHED"])
def test_reserve_on_closed_event_returns_409(client, create_event, closed_status):
    event = create_event()
    client.put(f"/events/{event['id']}", json={"status": closed_status})

    response = reserve(client, event)

    assert response.status_code == 409
    assert response.json() == {"detail": "Event is not open for registrations"}
    assert client.get(f"/events/{event['id']}").json()["available_spots"] == 2


def test_spot_operations_on_unknown_event_return_404(client):
    assert client.patch(f"/events/{UNKNOWN_ID}/reserve-spot").status_code == 404
    assert client.patch(f"/events/{UNKNOWN_ID}/release-spot").status_code == 404


def test_release_reopens_sold_out_event(client, create_event):
    event = create_event(max_capacity=1)
    reserve(client, event)

    released = release(client, event).json()

    assert (released["available_spots"], released["status"]) == (1, "PUBLISHED")


def test_release_at_full_capacity_changes_nothing(client, create_event):
    event = create_event(max_capacity=2)

    response = release(client, event)

    assert response.status_code == 200
    assert response.json()["available_spots"] == 2


def test_release_keeps_cancelled_status(client, create_event):
    event = create_event(max_capacity=2)
    reserve(client, event)
    client.put(f"/events/{event['id']}", json={"status": "CANCELLED"})

    released = release(client, event).json()

    assert (released["available_spots"], released["status"]) == (2, "CANCELLED")


def test_capacity_increase_preserves_occupied_spots(client, create_event):
    event = create_event(max_capacity=100)
    for _ in range(50):
        reserve(client, event)

    updated = client.put(f"/events/{event['id']}", json={"max_capacity": 200}).json()

    assert (updated["max_capacity"], updated["available_spots"]) == (200, 150)


def test_capacity_below_occupied_returns_409(client, create_event):
    event = create_event(max_capacity=3)
    reserve(client, event)
    reserve(client, event)

    response = client.put(f"/events/{event['id']}", json={"max_capacity": 1})

    assert response.status_code == 409
    assert client.get(f"/events/{event['id']}").json()["max_capacity"] == 3


def test_capacity_equal_to_occupied_marks_sold_out(client, create_event):
    event = create_event(max_capacity=3)
    reserve(client, event)

    updated = client.put(f"/events/{event['id']}", json={"max_capacity": 1}).json()

    assert (updated["available_spots"], updated["status"]) == (0, "SOLD_OUT")


def test_capacity_increase_reopens_sold_out_event(client, create_event):
    event = create_event(max_capacity=1)
    reserve(client, event)

    updated = client.put(f"/events/{event['id']}", json={"max_capacity": 2}).json()

    assert (updated["available_spots"], updated["status"]) == (1, "PUBLISHED")


def test_update_changes_only_sent_fields(client, create_event):
    event = create_event(description="Original")

    updated = client.put(f"/events/{event['id']}", json={"title": "Novo título"}).json()

    assert updated["title"] == "Novo título"
    assert updated["description"] == "Original"


def test_update_rejects_null_on_required_field(client, create_event):
    event = create_event()

    assert client.put(f"/events/{event['id']}", json={"title": None}).status_code == 422


def test_update_rejects_end_before_existing_start(client, create_event):
    event = create_event()

    response = client.put(f"/events/{event['id']}", json={"end_at": "2026-11-19T08:00:00-04:00"})

    assert response.status_code == 422


def test_correlation_id_is_returned_to_caller(client):
    response = client.get("/events", headers={"X-Correlation-Id": "demo-123"})

    assert response.headers["X-Correlation-Id"] == "demo-123"


def test_health_reports_database_up(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["database"] == "up"


def test_metrics_exposes_spot_operations(client, create_event):
    reserve(client, create_event())

    body = client.get("/metrics").text

    assert 'events_spot_operations_total{operation="reserve",result="success"}' in body


def test_swagger_documents_all_routes(client):
    paths = client.get("/openapi.json").json()["paths"]

    assert {
        "/events",
        "/events/{id}",
        "/events/{id}/reserve-spot",
        "/events/{id}/release-spot",
        "/health",
        "/metrics",
    } <= set(paths)
