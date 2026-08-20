from fastapi.testclient import TestClient

from private_ai_agentscope.protocol import BootstrapConfig
from private_ai_agentscope.service import create_app


def test_health_requires_exact_bearer_token() -> None:
    app = create_app(BootstrapConfig(
        token="x" * 32,
        user_data_dir="C:/tmp/private-ai",
        log_dir="C:/tmp/private-ai/logs",
    ))
    client = TestClient(app)

    assert client.get("/v1/health").status_code == 401
    assert client.get("/v1/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    response = client.get(
        "/v1/health",
        headers={"Authorization": f"Bearer {'x' * 32}"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "protocol_version": "1",
        "runtime_version": "1.0.0",
        "agentscope_version": "2.0.6",
    }


def test_ready_requires_exact_bearer_token() -> None:
    app = create_app(BootstrapConfig(
        token="x" * 32,
        user_data_dir="C:/tmp/private-ai",
        log_dir="C:/tmp/private-ai/logs",
    ))
    client = TestClient(app)

    assert client.get("/v1/ready").status_code == 401
    response = client.get(
        "/v1/ready",
        headers={"Authorization": f"Bearer {'x' * 32}"},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True
