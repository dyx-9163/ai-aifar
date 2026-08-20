import asyncio
import contextlib
import os
import signal
import socket
import sys
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


async def _wait_for_stdin_eof() -> None:
    await asyncio.to_thread(sys.stdin.buffer.read)


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

    ready = BootstrapReady(port=port, pid=os.getpid())
    sys.stdout.write(ready.model_dump_json() + "\n")
    sys.stdout.flush()

    server = _BootstrapServer(uvicorn.Config(
        create_app(config),
        host=None,
        port=None,
        log_config=None,
        access_log=False,
    ))
    sock_closed = False

    def request_shutdown() -> None:
        nonlocal sock_closed
        server.should_exit = True
        if not sock_closed:
            sock_closed = True
            sock.close()

    loop = asyncio.get_running_loop()
    previous_handlers = _install_shutdown_handlers(loop, request_shutdown)
    server_task = asyncio.create_task(server.serve(sockets=[sock]))
    eof_task = asyncio.create_task(_wait_for_stdin_eof())
    try:
        done, _ = await asyncio.wait(
            {server_task, eof_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if eof_task in done:
            request_shutdown()
        if not server_task.done():
            await server_task
        return 0
    finally:
        _restore_shutdown_handlers(previous_handlers)
        if not eof_task.done():
            eof_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await eof_task
        if not sock_closed:
            sock.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
