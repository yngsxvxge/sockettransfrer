import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 3000);
const publicDir = join(process.cwd(), "frontend");
const sessions = new Map<string, Set<Client>>();

type Json = Record<string, unknown>;

type Client = {
  id: string;
  socket: WebSocket;
  sessionCode?: string;
};

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/config.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(`window.TRANSFER_CONFIG = ${JSON.stringify(createClientConfig())};`);
    return;
  }

  if (url.pathname === "/app.js") {
    const source = readFileSync(join(publicDir, "app.ts"), "utf8");
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(stripTypeScriptTypes(source));
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream"
  });
  createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  const client: Client = { id: randomId(), socket };

  socket.on("message", (message) => handleMessage(client, message.toString("utf8")));
  socket.on("close", () => leaveSession(client));
  socket.on("error", () => leaveSession(client));
});

server.listen(port, () => {
  console.log(`Transfer MVP running on http://localhost:${port}`);
});

function handleMessage(client: Client, rawMessage: string) {
  let message: Json;

  try {
    message = JSON.parse(rawMessage);
  } catch {
    send(client, { type: "error", message: "Mensagem invalida." });
    return;
  }

  if (message.type === "create") {
    leaveSession(client);
    const code = createSessionCode();
    sessions.set(code, new Set([client]));
    client.sessionCode = code;
    send(client, { type: "created", code, participantId: client.id });
    return;
  }

  if (message.type === "join" && typeof message.code === "string") {
    const code = message.code.trim().toUpperCase();
    const peers = sessions.get(code);

    if (!peers) {
      send(client, { type: "error", message: "Sessao nao encontrada." });
      return;
    }

    if (peers.size >= 2) {
      send(client, { type: "error", message: "Sessao cheia." });
      return;
    }

    leaveSession(client);
    const existingPeers = [...peers].map((peer) => peer.id);
    peers.add(client);
    client.sessionCode = code;
    send(client, { type: "joined", code, participantId: client.id, peers: existingPeers });
    broadcast(client, { type: "peer-joined", peerId: client.id });
    return;
  }

  if (message.type === "signal" && message.data && client.sessionCode) {
    broadcast(client, { type: "signal", from: client.id, data: message.data });
  }
}

function leaveSession(client: Client) {
  if (!client.sessionCode) return;

  const peers = sessions.get(client.sessionCode);
  peers?.delete(client);
  broadcast(client, { type: "peer-left", peerId: client.id });

  if (!peers?.size) {
    sessions.delete(client.sessionCode);
  }

  client.sessionCode = undefined;
}

function broadcast(sender: Client, message: Json) {
  if (!sender.sessionCode) return;

  for (const peer of sessions.get(sender.sessionCode) ?? []) {
    if (peer !== sender) send(peer, message);
  }
}

function send(client: Client, payload: Json) {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  client.socket.send(JSON.stringify(payload));
}

function createSessionCode() {
  let code = "";

  do {
    code = randomBytes(3).toString("hex").toUpperCase();
  } while (sessions.has(code));

  return code;
}

function randomId() {
  return randomBytes(8).toString("hex");
}

function createClientConfig() {
  const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const turnUrls = process.env.TURN_URLS?.split(",").map((url) => url.trim()).filter(Boolean);

  if (turnUrls?.length) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  return { iceServers };
}
