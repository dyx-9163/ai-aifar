import json
import os
import subprocess
import sys
import urllib.request

import pytest


def test_bootstrap_emits_one_redacted_ready_line_and_stops(tmp_path) -> None:
    token = "t" * 48
    process = subprocess.Popen(
        [sys.executable, "-m", "private_ai_agentscope.bootstrap"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    process.stdin.write(json.dumps({
        "token": token,
        "user_data_dir": str(tmp_path),
        "log_dir": str(tmp_path / "logs"),
    }) + "\n")
    process.stdin.flush()

    line = process.stdout.readline()
    ready = json.loads(line)
    assert ready["type"] == "agentscope.ready"
    assert ready["protocol_version"] == "1"
    assert token not in line

    request = urllib.request.Request(
        f"http://127.0.0.1:{ready['port']}/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert json.loads(urllib.request.urlopen(request, timeout=5).read())["ok"] is True

    process.stdin.close()
    assert process.wait(timeout=5) == 0
    assert token not in process.stderr.read()


@pytest.mark.parametrize(
    ("payload", "secret"),
    [
        (b"{not-json}\n", b"{not-json}"),
        (
            b'{"token":"' + b"o" * (16 * 1024) + b'","user_data_dir":"x","log_dir":"x"}\n',
            b"o" * 48,
        ),
    ],
)
def test_bootstrap_rejects_malformed_or_oversized_input_without_echoing_it(
    payload: bytes,
    secret: bytes,
) -> None:
    process = subprocess.Popen(
        [sys.executable, "-m", "private_ai_agentscope.bootstrap"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    stdout, stderr = process.communicate(payload, timeout=5)

    assert process.returncode != 0
    assert payload not in stdout
    assert payload not in stderr
    assert secret not in stdout
    assert secret not in stderr
