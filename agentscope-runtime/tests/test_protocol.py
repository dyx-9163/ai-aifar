from pathlib import Path

from private_ai_agentscope.protocol import (
    AGENTSCOPE_VERSION,
    PROTOCOL_VERSION,
    RUNTIME_VERSION,
    BootstrapConfig,
    BootstrapReady,
)


def test_python_runtime_is_pinned_to_3_11_16() -> None:
    pyproject = Path(__file__).parents[1] / "pyproject.toml"

    assert 'requires-python = "==3.11.16"' in pyproject.read_text()


def test_bootstrap_contract_is_versioned_and_redacted() -> None:
    token = "s" * 32
    config = BootstrapConfig.model_validate({
        "token": token,
        "user_data_dir": "C:/tmp/private-ai",
        "log_dir": "C:/tmp/private-ai/logs",
    })
    ready = BootstrapReady(port=49152, pid=1234)

    assert PROTOCOL_VERSION == "1"
    assert RUNTIME_VERSION == "1.0.0"
    assert AGENTSCOPE_VERSION == "2.0.6"
    assert ready.model_dump() == {
        "type": "agentscope.ready",
        "protocol_version": "1",
        "runtime_version": "1.0.0",
        "agentscope_version": "2.0.6",
        "port": 49152,
        "pid": 1234,
    }
    assert token not in repr(config)
