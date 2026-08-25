import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";

const port = 3217;

async function startServer() {
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), SESSION_TTL_MS: "60000" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForHealth(child);
  return child;
}

async function waitForHealth(child: ChildProcess) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Servidor nao iniciou. ${child.stderr?.read() ?? ""}`);
}

test("exposes health, config and creates an eight-character session", async () => {
  const server = await startServer();
  const sockets: WebSocket[] = [];
  try {
    const health = await fetch(`http://localhost:${port}/health`).then((response) => response.json()) as { status: string };
    assert.equal(health.status, "ok");

    const config = await fetch(`http://localhost:${port}/config.json`).then((response) => response.json()) as { iceServers: unknown[] };
    assert.ok(config.iceServers.length > 0);

    const socket = new WebSocket(`ws://localhost:${port}/ws`);
    sockets.push(socket);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "create" }));
    const [rawMessage] = await once(socket, "message");
    const message = JSON.parse(rawMessage.toString()) as { type: string; code: string };
    assert.equal(message.type, "created");
    assert.match(message.code, /^[A-Z0-9]{8}$/);
  } finally {
    for (const socket of sockets) socket.close();
    server.kill();
  }
});
