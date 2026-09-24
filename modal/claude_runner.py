from pathlib import Path
import subprocess

import modal


ROOT = Path(__file__).parent

image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .run_commands(
        "mkdir -p /app",
        "cd /app && npm init -y",
        "cd /app && npm install @anthropic-ai/claude-agent-sdk@0.3.281 convex@1.46.0 zod@4.1.12",
    )
    .add_local_file(ROOT / "claude-runner.mjs", "/app/claude-runner.mjs")
)

app = modal.App("novamind-claude-agent-runner")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("novamind-claude-agent-runtime")],
    timeout=800,
    scaledown_window=300,
)
@modal.concurrent(max_inputs=8)
@modal.web_server(8000, startup_timeout=60)
def serve():
    subprocess.Popen(["node", "/app/claude-runner.mjs"])
