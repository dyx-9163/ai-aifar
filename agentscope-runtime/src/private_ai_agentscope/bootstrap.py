import asyncio
import contextlib
import os
import signal
import socket
import sys
import threading
from collections.abc import Callable, Generator

import uvicorn

from .protocol import BootstrapConfig, BootstrapReady
from .service import create_app

MAX_BOOTSTRAP_BYTES = 16 * 1024


class _BootstrapServer(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self) -> Generator[None, None, None]:
        yield


def _write_invalid_input_error() -> int:
    sys.stderr.write("invalid bootstrap input\n")
    sys.stderr.flush()
    return 1


def _install_shutdown_handlers(
    loop: asyncio.AbstractEventLoop,
    request_shutdown: Callable[[], None],
) -> list[tuple[signal.Signals, Callable]]:
    handled_signals: list[signal.Signals] = [signal.SIGTERM]
    if sys.platform == "win32":
        sigbreak = getattr(signal, "SIGBREAK", None)
        if sigbreak is not None:
            handled_signals.append(sigbreak)

    previous_handlers: list[tuple[signal.Signals, Callable]] = []

    def handle_signal(_signum: int, _frame: object) -> None:
        loop.call_soon_threadsafe(request_shutdown)

    for handled_signal in handled_signals:
        previous_handlers.append((handled_signal, signal.signal(handled_signal, handle_signal)))
    return previous_handlers


def _restore_shutdown_handlers(previous_handlers: list[tuple[signal.Signals, Callable]]) -> None:
    for handled_signal, previous_handler in previous_handlers:
        signal.signal(handled_signal, previous_handler)


def _start_stdin_eof_watcher(
    loop: asyncio.AbstractEventLoop,
    request_shutdown: Callable[[], None],
) -> None:
    def watch_stdin() -> None:
        try:
            while os.read(sys.stdin.fileno(), 8192):
                pass
        except (AttributeError, OSError):
            return
        try:
            loop.call_soon_threadsafe(request_shutdown)
        except RuntimeError:
            return

    threading.Thread(target=watch_stdin, daemon=True).start()


async def main() -> int:
    raw = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_BOOTSTRAP_BYTES + 1)
    if not raw or len(raw) > MAX_BOOTSTRAP_BYTES or not raw.endswith(b"\n"):
        return _write_invalid_input_error()

    try:
        config = BootstrapConfig.model_validate_json(raw)
    except ValueError:
        return _write_invalid_input_error()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = int(sock.getsockname()[1])

    server = _BootstrapServer(uvicorn.Config(
        create_app(config),
        host=None,
        port=None,
        log_config=None,
        access_log=False,
    ))
    listener_transferred = False

    def request_shutdown() -> None:
        server.should_exit = True

    loop = asyncio.get_running_loop()
    previous_handlers = _install_shutdown_handlers(loop, request_shutdown)
    try:
        ready = BootstrapReady(port=port, pid=os.getpid())
        sys.stdout.write(ready.model_dump_json() + "\n")
        sys.stdout.flush()

        _start_stdin_eof_watcher(loop, request_shutdown)
        listener_transferred = True
        await server.serve(sockets=[sock])
        return 0
    finally:
        _restore_shutdown_handlers(previous_handlers)
        if not listener_transferred:
            sock.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
