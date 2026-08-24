import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";

const port = Number(process.env.PORT ?? 3000);
const publicDir = join(process.cwd(), "frontend");
const sessions = new Map<string, Set<Client>>();

type Json = Record<string, unknown>;

type Client = {
  id: string;
  socket: DuplexSocket;
  pendingBuffer: Buffer;
  sessionCode?: string;
};

type DuplexSocket = NodeJS.ReadWriteStream & {
  destroyed?: boolean;
};

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

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

server.on("upgrade", (req, socket) => {
  if (new URL(req.url ?? "/", `http://${req.headers.host}`).pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }

  socket.write(createHandshakeResponse(key));
  const client: Client = { id: randomId(), pendingBuffer: Buffer.alloc(0), socket };

  socket.on("data", (buffer) => {
    client.pendingBuffer = Buffer.concat([client.pendingBuffer, buffer]);

    const result = decodeFrames(client.pendingBuffer);
    client.pendingBuffer = result.rest;

    for (const message of result.messages) {
      handleMessage(client, message);
    }
  });

  socket.on("close", () => leaveSession(client));
  socket.on("end", () => leaveSession(client));
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
  if (client.socket.destroyed) return;
  client.socket.write(encodeFrame(JSON.stringify(payload)));
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

function createHandshakeResponse(key: string) {
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n");
}

function decodeFrames(buffer: Buffer) {
  const messages: string[] = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const frameOffset = offset;
    const firstByte = buffer[offset++];
    const secondByte = buffer[offset++];
    const opcode = firstByte & 0x0f;
    let length = secondByte & 0x7f;

    if (length === 126) {
      if (offset + 2 > buffer.length) return { messages, rest: buffer.subarray(frameOffset) };
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) return { messages, rest: buffer.subarray(frameOffset) };
      const largeLength = buffer.readBigUInt64BE(offset);
      length = Number(largeLength);
      offset += 8;
    }

    if (offset + 4 + length > buffer.length) return { messages, rest: buffer.subarray(frameOffset) };

    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;

    const payload = buffer.subarray(offset, offset + length);
    offset += length;

    if (opcode === 8) break;
    if (opcode !== 1) continue;

    const decoded = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) {
      decoded[i] = payload[i] ^ mask[i % 4];
    }
    messages.push(decoded.toString("utf8"));
  }

  return { messages, rest: buffer.subarray(offset) };
}

function encodeFrame(message: string) {
  const payload = Buffer.from(message);
  const length = payload.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}
