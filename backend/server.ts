import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 3000);
const sessionTtlMs = Number(process.env.SESSION_TTL_MS ?? 30 * 60 * 1000);
const maxMessageBytes = 64 * 1024;
const rateWindowMs = 60 * 1000;
const maxCreatesPerWindow = Number(process.env.MAX_SESSION_CREATES_PER_MINUTE ?? 10);
const maxJoinsPerWindow = Number(process.env.MAX_SESSION_JOINS_PER_MINUTE ?? 30);
const maxSessions = Number(process.env.MAX_SESSIONS ?? 1000);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
const projectDir = existsSync(join(process.cwd(), "dist")) ? process.cwd() : join(process.cwd(), "..");
const distDir = join(projectDir, "dist");
const sessions = new Map<string, Session>();
const rateLimits = new Map<string, RateLimit>();

type Json = Record<string, unknown>;

type Client = {
  id: string;
  socket: WebSocket;
  ip: string;
  sessionCode?: string;
};

type Session = {
  code: string;
  clients: Set<Client>;
  createdAt: number;
  expiresAt: number;
  expiresTimer: NodeJS.Timeout;
};

type RateLimit = {
  startedAt: number;
  creates: number;
  joins: number;
};

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", sessions: sessions.size });
    return;
  }

  if (url.pathname === "/config.json") {
    sendJson(res, 200, createClientConfig(), req.headers.origin);
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const staticDir = distDir;
  const filePath = normalize(join(staticDir, requestedPath));

  if (!filePath.startsWith(`${staticDir}${process.platform === "win32" ? "\\" : "/"}`) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream"
  });
  createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: maxMessageBytes });

wss.on("connection", (socket, request) => {
  if (!isAllowedOrigin(request.headers.origin)) {
    socket.close(1008, "Origin nao permitido");
    return;
  }
  const client: Client = { id: randomId(), socket, ip: request.socket.remoteAddress ?? "unknown" };
  (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
  socket.on("pong", () => {
    (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
  });

  socket.on("message", (message) => handleMessage(client, message.toString("utf8")));
  socket.on("close", () => leaveSession(client));
  socket.on("error", () => leaveSession(client));
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    const heartbeatSocket = socket as WebSocket & { isAlive?: boolean };
    if (heartbeatSocket.isAlive === false) {
      socket.terminate();
      continue;
    }
    heartbeatSocket.isAlive = false;
    socket.ping();
  }
}, 30_000);
heartbeat.unref();
const rateCleanup = setInterval(() => {
  const threshold = Date.now() - rateWindowMs;
  for (const [ip, rate] of rateLimits) if (rate.startedAt < threshold) rateLimits.delete(ip);
}, rateWindowMs);
rateCleanup.unref();

server.listen(port, () => {
  console.log(`Transfer MVP running on http://localhost:${port}`);
});

function handleMessage(client: Client, rawMessage: string) {
  if (Buffer.byteLength(rawMessage, "utf8") > maxMessageBytes) {
    send(client, { type: "error", message: "Mensagem muito grande." });
    return;
  }
  let message: Json;

  try {
    message = JSON.parse(rawMessage);
  } catch {
    send(client, { type: "error", message: "Mensagem invalida." });
    return;
  }

  if (message.type === "create") {
    if (sessions.size >= maxSessions) {
      send(client, { type: "error", message: "Servidor temporariamente cheio." });
      return;
    }
    if (!consumeRate(client, "creates", maxCreatesPerWindow)) {
      send(client, { type: "error", message: "Limite de criacao atingido. Tente novamente depois." });
      return;
    }
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
    if (!/^[A-Z0-9]{8}$/.test(message.code.trim().toUpperCase())) {
      send(client, { type: "error", message: "Codigo de sessao invalido." });
      return;
    }
    if (!consumeRate(client, "joins", maxJoinsPerWindow)) {
      send(client, { type: "error", message: "Muitas tentativas. Tente novamente depois." });
      return;
    }
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

  if (message.type === "signal" && isRtcSignal(message.data) && client.sessionCode) {
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
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  do {
    code = [...randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join("");
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

  const apiUrl = process.env.PUBLIC_API_URL ?? "";
  const wsUrl = process.env.PUBLIC_WS_URL ?? "";
  return { iceServers, apiUrl, wsUrl };
}

function sendJson(res: import("node:http").ServerResponse, status: number, payload: unknown, origin?: string) {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (origin && isAllowedOrigin(origin)) headers["access-control-allow-origin"] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function isAllowedOrigin(origin?: string) {
  return !allowedOrigins.size || !origin || allowedOrigins.has(origin);
}

function clientIp(client: Client) {
  return client.ip;
}

function consumeRate(client: Client, field: "creates" | "joins", limit: number) {
  const now = Date.now();
  const key = clientIp(client);
  const current = rateLimits.get(key);
  const rate = !current || now - current.startedAt >= rateWindowMs
    ? { startedAt: now, creates: 0, joins: 0 }
    : current;
  rate[field] += 1;
  rateLimits.set(key, rate);
  return rate[field] <= limit;
}

function isRtcSignal(value: unknown): value is Json {
  if (!value || typeof value !== "object") return false;
  const signal = value as Record<string, unknown>;
  if (signal.kind === "ice") return Boolean(signal.candidate && typeof signal.candidate === "object");
  if (signal.kind === "offer" || signal.kind === "answer") return Boolean(signal.description && typeof signal.description === "object");
  return false;
}
