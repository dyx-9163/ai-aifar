import io
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import urllib.request

import pytest

from private_ai_agentscope import bootstrap


class _BoundedLineReader:
    def __init__(self, stream) -> None:
        self._result: queue.Queue[str | BaseException] = queue.Queue(maxsize=1)
        self._thread = threading.Thread(target=self._read, args=(stream,), daemon=True)
        self._thread.start()

    def _read(self, stream) -> None:
        try:
            self._result.put(stream.readline())
        except BaseException as error:
            self._result.put(error)

    def read(self, timeout: float) -> str:
        try:
            result = self._result.get(timeout=timeout)
        except queue.Empty as error:
            raise TimeoutError("ready line did not arrive before the timeout") from error
        if isinstance(result, BaseException):
            raise result
        return result

    def join(self) -> None:
        self._thread.join(timeout=5)
        assert not self._thread.is_alive()

_WINDOWS_CONTROL_BREAK_WRAPPER = r'''
import json
import os
import queue
import signal
import subprocess
import sys
import threading

result_queue = queue.Queue(maxsize=1)

def read_ready_line(stream):
    try:
        result_queue.put(stream.readline())
    except BaseException as error:
        result_queue.put(error)

process = subprocess.Popen(
    [sys.executable, "-m", "private_ai_agentscope.bootstrap"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
    env={**os.environ, "PYTHONUNBUFFERED": "1"},
)
try:
    process.stdin.write(os.environ["BOOTSTRAP_CONFIG"] + "\n")
    process.stdin.flush()
    reader = threading.Thread(target=read_ready_line, args=(process.stdout,), daemon=True)
    reader.start()
    try:
        ready_line = result_queue.get(timeout=5)
    except queue.Empty:
        ready_line = ""
        ready_timed_out = True
    else:
        ready_timed_out = False
        if isinstance(ready_line, BaseException):
            raise ready_line
        os.kill(process.pid, signal.CTRL_BREAK_EVENT)
    try:
        returncode = process.wait(timeout=5)
        shutdown_timed_out = False
    except subprocess.TimeoutExpired:
        shutdown_timed_out = True
        process.kill()
        returncode = process.wait(timeout=5)
    print(json.dumps({
        "ready_line": ready_line,
        "ready_timed_out": ready_timed_out,
        "returncode": returncode,
        "shutdown_timed_out": shutdown_timed_out,
        "stdout_tail": process.stdout.read(),
        "stderr": process.stderr.read(),
    }))
finally:
    if process.poll() is None:
        process.kill()
        process.wait(timeout=5)
    if 'reader' in locals():
        reader.join(timeout=5)
        if reader.is_alive():
            raise RuntimeError("ready-line reader did not stop")
'''


def _start_bootstrap(*, text: bool = True) -> subprocess.Popen:
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    return subprocess.Popen(
        [sys.executable, "-m", "private_ai_agentscope.bootstrap"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
        creationflags=creationflags,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )


def _stop_process(process: subprocess.Popen) -> None:
    if process.stdin is not None and not process.stdin.closed:
        process.stdin.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _send_graceful_signal(process: subprocess.Popen) -> None:
    process.send_signal(signal.SIGTERM)


def _write_config(process: subprocess.Popen, token: str, tmp_path) -> None:
    assert process.stdin is not None
    process.stdin.write(json.dumps({
        "token": token,
        "user_data_dir": str(tmp_path),
        "log_dir": str(tmp_path / "logs"),
    }) + "\n")
    process.stdin.flush()


def _read_ready(process: subprocess.Popen) -> tuple[str, dict]:
    assert process.stdout is not None
    reader = _BoundedLineReader(process.stdout)
    try:
        line = reader.read(timeout=5)
        return line, json.loads(line)
    finally:
        reader.join()


def test_bootstrap_emits_exactly_one_redacted_ready_line_and_stops_on_eof(tmp_path) -> None:
    token = "t" * 48
    process = _start_bootstrap()
    try:
        _write_config(process, token, tmp_path)
        line, ready = _read_ready(process)
        assert ready["type"] == "agentscope.ready"
        assert ready["protocol_version"] == "1"

        request = urllib.request.Request(
            f"http://127.0.0.1:{ready['port']}/v1/health",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert json.loads(urllib.request.urlopen(request, timeout=5).read())["ok"] is True

        assert process.stdin is not None
        process.stdin.close()
        assert process.wait(timeout=5) == 0
        assert process.stdout is not None
        assert process.stderr is not None
        stdout_tail = process.stdout.read()
        stderr = process.stderr.read()
        assert stdout_tail == ""
        assert token not in line
        assert token not in stderr
    finally:
        _stop_process(process)


def test_bootstrap_stops_gracefully_on_supervisor_signal(tmp_path) -> None:
    if os.name == "nt":
        token = "s" * 48
        config = json.dumps({
            "token": token,
            "user_data_dir": str(tmp_path),
            "log_dir": str(tmp_path / "logs"),
        })
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        wrapper = subprocess.Popen(
            [sys.executable, "-c", _WINDOWS_CONTROL_BREAK_WRAPPER],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=subprocess.CREATE_NEW_CONSOLE,
            startupinfo=startupinfo,
            env={**os.environ, "BOOTSTRAP_CONFIG": config},
        )
        try:
            stdout, _ = wrapper.communicate(timeout=15)
            assert wrapper.returncode == 0
            result = json.loads(stdout)
            assert json.loads(result["ready_line"])["type"] == "agentscope.ready"
            assert result["returncode"] == 0
            assert result["ready_timed_out"] is False
            assert result["shutdown_timed_out"] is False
            assert result["stdout_tail"] == ""
            assert token not in result["ready_line"]
            assert token not in result["stderr"]
        finally:
            _stop_process(wrapper)
        return

    process = _start_bootstrap()
    try:
        _write_config(process, "s" * 48, tmp_path)
        _read_ready(process)

        _send_graceful_signal(process)
        assert process.wait(timeout=5) == 0
    finally:
        _stop_process(process)


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
    process = _start_bootstrap(text=False)
    try:
        stdout, stderr = process.communicate(payload, timeout=5)

        assert process.returncode != 0
        assert payload not in stdout
        assert payload not in stderr
        assert secret not in stdout
        assert secret not in stderr
    finally:
        _stop_process(process)


def test_bounded_ready_read_cleans_up_a_bootstrap_process_that_never_emits_ready() -> None:
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import private_ai_agentscope.bootstrap; import time; time.sleep(60)",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    assert process.stdout is not None
    reader = None
    try:
        reader = _BoundedLineReader(process.stdout)
        with pytest.raises(TimeoutError, match="ready line"):
            reader.read(timeout=0.1)
        assert process.poll() is None
    finally:
        _stop_process(process)
        if reader is not None:
            reader.join()

    assert process.returncode is not None


@pytest.mark.asyncio
async def test_main_propagates_server_failure(monkeypatch, tmp_path) -> None:
    class ExplodingServer:
        def __init__(self, _config) -> None:
            self.should_exit = False

        async def serve(self, *, sockets) -> None:
            sockets[0].close()
            raise RuntimeError("server failed")

    token = "x" * 48
    payload = json.dumps({
        "token": token,
        "user_data_dir": str(tmp_path),
        "log_dir": str(tmp_path / "logs"),
    }).encode() + b"\n"
    monkeypatch.setattr(bootstrap.sys, "stdin", type("Input", (), {"buffer": io.BytesIO(payload)})())
    monkeypatch.setattr(bootstrap, "_BootstrapServer", ExplodingServer)

    with pytest.raises(RuntimeError, match="server failed"):
        await bootstrap.main()
