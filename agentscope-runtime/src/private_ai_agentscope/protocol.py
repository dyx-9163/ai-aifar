from pydantic import BaseModel, ConfigDict, Field, SecretStr

PROTOCOL_VERSION = "1"
RUNTIME_VERSION = "1.0.0"
AGENTSCOPE_VERSION = "2.0.6"


class BootstrapConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: SecretStr = Field(min_length=32, max_length=256)
    user_data_dir: str = Field(min_length=1)
    log_dir: str = Field(min_length=1)


class BootstrapReady(BaseModel):
    type: str = "agentscope.ready"
    protocol_version: str = PROTOCOL_VERSION
    runtime_version: str = RUNTIME_VERSION
    agentscope_version: str = AGENTSCOPE_VERSION
    port: int = Field(ge=1, le=65535)
    pid: int = Field(gt=0)


class RuntimeHealth(BaseModel):
    ok: bool = True
    protocol_version: str = PROTOCOL_VERSION
    runtime_version: str = RUNTIME_VERSION
    agentscope_version: str = AGENTSCOPE_VERSION
