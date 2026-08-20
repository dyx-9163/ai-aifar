import hmac

from fastapi import FastAPI, Header, HTTPException

from .protocol import BootstrapConfig, RuntimeHealth


def create_app(config: BootstrapConfig) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    expected = f"Bearer {config.token.get_secret_value()}"

    def authorize(authorization: str | None = Header(default=None)) -> None:
        if authorization is None or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/v1/health", response_model=RuntimeHealth, dependencies=[])
    def health(authorization: str | None = Header(default=None)) -> RuntimeHealth:
        authorize(authorization)
        return RuntimeHealth()

    @app.get("/v1/ready", response_model=RuntimeHealth, dependencies=[])
    def ready(authorization: str | None = Header(default=None)) -> RuntimeHealth:
        authorize(authorization)
        return RuntimeHealth()

    return app
