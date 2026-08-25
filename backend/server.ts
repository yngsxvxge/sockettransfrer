import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 3000);
const sessionTtlMs = Number(process.env.SESSION_TTL_MS ?? 30 * 60 * 1000);
const projectDir = existsSync(join(process.cwd(), "dist")) ? process.cwd() : join(process.cwd(), "..");
const distDir = join(projectDir, "dist");
const sessions = new Map<string, Session>();

type Json = Record<string, unknown>;

type Client = {
  id: string;
  socket: WebSocket;
  sessionCode?: string;
};

type Session = {
  code: string;
  clients: Set<Client>;
  createdAt: number;
  expiresAt: number;
  expiresTimer: NodeJS.Timeout;
};

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/config.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(createClientConfig()));
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const staticDir = distDir;
  const filePath = normalize(join(staticDir, requestedPath));

  if (!filePath.startsWith(staticDir) || !existsSync(filePath)) {
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
    const session = createSession();
    session.clients.add(client);
    client.sessionCode = session.code;
    send(client, {
      type: "created",
      code: session.code,
      expiresAt: session.expiresAt,
      participantId: client.id
    });
    return;
  }

  if (message.type === "join" && typeof message.code === "string") {
    const code = message.code.trim().toUpperCase();
    const session = sessions.get(code);

    if (!session || session.expiresAt <= Date.now()) {
      if (session) expireSession(session.code);
      send(client, { type: "error", message: "Sessao nao encontrada." });
      return;
    }

    if (session.clients.size >= 2) {
      send(client, { type: "error", message: "Sessao cheia." });
      return;
    }

    leaveSession(client);
    const existingPeers = [...session.clients].map((peer) => peer.id);
    session.clients.add(client);
    client.sessionCode = code;
    send(client, { type: "joined", code, expiresAt: session.expiresAt, participantId: client.id, peers: existingPeers });
    broadcast(client, { type: "peer-joined", peerId: client.id });
    return;
  }

  if (message.type === "signal" && message.data && client.sessionCode) {
    broadcast(client, { type: "signal", from: client.id, data: message.data });
  }
}

function leaveSession(client: Client) {
  if (!client.sessionCode) return;

  const session = sessions.get(client.sessionCode);
  session?.clients.delete(client);
  broadcast(client, { type: "peer-left", peerId: client.id });

  if (session && !session.clients.size) {
    closeSession(session.code);
  }

  client.sessionCode = undefined;
}

function broadcast(sender: Client, message: Json) {
  if (!sender.sessionCode) return;

  for (const peer of sessions.get(sender.sessionCode)?.clients ?? []) {
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

function createSession() {
  const code = createSessionCode();
  const now = Date.now();
  const session: Session = {
    code,
    clients: new Set(),
    createdAt: now,
    expiresAt: now + sessionTtlMs,
    expiresTimer: setTimeout(() => expireSession(code), sessionTtlMs)
  };

  sessions.set(code, session);
  return session;
}

function expireSession(code: string) {
  const session = sessions.get(code);
  if (!session) return;

  for (const client of session.clients) {
    send(client, { type: "session-expired", code });
    client.sessionCode = undefined;
  }

  closeSession(code);
}

function closeSession(code: string) {
  const session = sessions.get(code);
  if (!session) return;

  clearTimeout(session.expiresTimer);
  sessions.delete(code);
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
