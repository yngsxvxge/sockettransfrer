const createSessionButton = queryElement<HTMLButtonElement>("#createSession");
const joinForm = queryElement<HTMLFormElement>("#joinForm");
const sessionCodeInput = queryElement<HTMLInputElement>("#sessionCode");
const statusText = queryElement<HTMLSpanElement>("#statusText");
const codeText = queryElement<HTMLElement>("#codeText");
const connectionPill = queryElement<HTMLElement>("#connectionPill");
const fileInput = queryElement<HTMLInputElement>("#fileInput");
const fileLabel = queryElement<HTMLSpanElement>("#fileLabel");
const fileMeta = queryElement<HTMLElement>("#fileMeta");
const sendFileButton = queryElement<HTMLButtonElement>("#sendFile");
const pauseTransferButton = queryElement<HTMLButtonElement>("#pauseTransfer");
const cancelTransferButton = queryElement<HTMLButtonElement>("#cancelTransfer");
const progress = queryElement<HTMLProgressElement>("#progress");
const progressText = queryElement<HTMLElement>("#progressText");
const logList = queryElement<HTMLUListElement>("#log");

const chunkSize = 16 * 1024;
const transferConfig = (window as TransferWindow).TRANSFER_CONFIG ?? {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};
let ws: WebSocket | undefined;
let peerConnection: RTCPeerConnection | undefined;
let dataChannel: RTCDataChannel | undefined;
let sessionCode = "";
let incomingFile: IncomingFile | undefined;
let pendingIncomingChunk: Extract<FileMessage, { kind: "file-chunk" }> | undefined;
let outboundQueue: File[] = [];
let pendingOutboundFile: File | undefined;
let transferCancelled = false;
let transferPaused = false;
let resumeTransfer: (() => void) | undefined;

type SignalingMessage =
  | { type: "created"; code: string; expiresAt: number; participantId: string }
  | { type: "joined"; code: string; expiresAt: number; participantId: string; peers: string[] }
  | { type: "peer-joined"; peerId: string }
  | { type: "peer-left"; peerId: string }
  | { type: "session-expired"; code: string }
  | { type: "signal"; from: string; data: RtcSignal }
  | { type: "error"; message: string };

type RtcSignal =
  | { kind: "offer"; description: RTCSessionDescriptionInit }
  | { kind: "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

type FileMessage =
  | { kind: "file-offer"; name: string; size: number; type: string }
  | { kind: "file-chunk"; index: number; size: number; sha256: string }
  | { kind: "file-ready" }
  | { kind: "file-rejected" }
  | { kind: "file-cancel" }
  | { kind: "file-pause" }
  | { kind: "file-resume" }
  | { kind: "file-received" }
  | { kind: "file-done" };

type IncomingFile = {
  name: string;
  size: number;
  type?: string;
  received: number;
  chunks?: ArrayBuffer[];
  writable?: FileSystemWritableFileStream;
  writeQueue?: Promise<void>;
};

type SavePickerWindow = Window &
  typeof globalThis & {
    showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
  };

type TransferWindow = Window &
  typeof globalThis & {
    TRANSFER_CONFIG?: {
      iceServers: RTCIceServer[];
    };
  };

createSessionButton.addEventListener("click", () => {
  connectSocket();
  ws?.addEventListener("open", () => sendSignal({ type: "create" }), { once: true });
});

fileInput.addEventListener("change", () => {
  const files = [...(fileInput.files ?? [])];
  const totalSize = files.reduce((total, file) => total + file.size, 0);
  fileLabel.textContent =
    files.length === 0 ? "Selecionar arquivo" : files.length === 1 ? files[0].name : `${files.length} arquivos`;
  fileMeta.textContent = files.length ? formatBytes(totalSize) : "Nenhum arquivo selecionado";
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = sessionCodeInput.value.trim().toUpperCase();
  if (!code) return;

  connectSocket();
  ws?.addEventListener("open", () => sendSignal({ type: "join", code }), { once: true });
});

sendFileButton.addEventListener("click", () => {
  const files = [...(fileInput.files ?? [])];
  if (!files.length || !dataChannel || dataChannel.readyState !== "open") return;

  outboundQueue = files;
  transferCancelled = false;
  transferPaused = false;
  sendFileButton.disabled = true;
  pauseTransferButton.disabled = false;
  cancelTransferButton.disabled = false;
  setProgress(0);
  log(`Fila criada com ${files.length} arquivo${files.length === 1 ? "" : "s"}.`);
  offerNextFile();
});

cancelTransferButton.addEventListener("click", () => {
  cancelTransfer("Transferencia cancelada.");
  dataChannel?.send(JSON.stringify({ kind: "file-cancel" }));
});

pauseTransferButton.addEventListener("click", () => {
  if (transferPaused) {
    setTransferPaused(false);
    dataChannel?.send(JSON.stringify({ kind: "file-resume" }));
    log("Transferencia retomada.");
    return;
  }

  setTransferPaused(true);
  dataChannel?.send(JSON.stringify({ kind: "file-pause" }));
  log("Transferencia pausada.");
});

function connectSocket() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;

  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  setStatus("Conectando...", "pending");

  ws.addEventListener("message", async (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as SignalingMessage;

    if (message.type === "created") {
      sessionCode = message.code;
      codeText.textContent = sessionCode;
      setStatus("Aguardando par", "pending");
      log(`Sessao ${sessionCode} criada.`);
      return;
    }

    if (message.type === "joined") {
      sessionCode = message.code;
      codeText.textContent = sessionCode;
      setStatus("Conectando WebRTC", "pending");
      preparePeerConnection(false);
      return;
    }

    if (message.type === "peer-joined") {
      setStatus("Criando canal", "pending");
      preparePeerConnection(true);
      return;
    }

    if (message.type === "signal") {
      await handleRtcSignal(message.data);
      return;
    }

    if (message.type === "peer-left") {
      setStatus("Par desconectado", "error");
      disableTransfer();
      return;
    }

    if (message.type === "session-expired") {
      sessionCode = "";
      codeText.textContent = "";
      setStatus("Sessao expirada", "error");
      disableTransfer();
      log("Sessao expirada. Crie uma nova sessao para continuar.");
      return;
    }

    if (message.type === "error") {
      setStatus(message.message, "error");
    }
  });

  ws.addEventListener("close", () => {
    setStatus("WebSocket desconectado", "error");
    disableTransfer();
  });
}

function preparePeerConnection(isInitiator: boolean) {
  peerConnection = new RTCPeerConnection({
    iceServers: transferConfig.iceServers
  });

  peerConnection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendSignal({ type: "signal", data: { kind: "ice", candidate: event.candidate.toJSON() } });
    }
  });

  peerConnection.addEventListener("connectionstatechange", () => {
    if (!peerConnection) return;
    const state = peerConnection.connectionState;
    setStatus(`WebRTC: ${state}`, state === "connected" ? "active" : state === "failed" ? "error" : "pending");
  });

  peerConnection.addEventListener("datachannel", (event) => setupDataChannel(event.channel));

  if (isInitiator) {
    setupDataChannel(peerConnection.createDataChannel("files"));
    void createOffer();
  }
}

async function createOffer() {
  if (!peerConnection) return;

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  sendSignal({ type: "signal", data: { kind: "offer", description: offer } });
}

async function handleRtcSignal(data: RtcSignal) {
  if (!peerConnection) preparePeerConnection(false);
  if (!peerConnection) return;

  if (data.kind === "offer") {
    await peerConnection.setRemoteDescription(data.description);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignal({ type: "signal", data: { kind: "answer", description: answer } });
    return;
  }

  if (data.kind === "answer") {
    await peerConnection.setRemoteDescription(data.description);
    return;
  }

  if (data.kind === "ice") {
    await peerConnection.addIceCandidate(data.candidate);
  }
}

function setupDataChannel(channel: RTCDataChannel) {
  dataChannel = channel;
  dataChannel.binaryType = "arraybuffer";
  dataChannel.bufferedAmountLowThreshold = chunkSize * 4;

  dataChannel.addEventListener("open", () => {
    setStatus("Conectado", "active");
    fileInput.disabled = false;
    sendFileButton.disabled = false;
    log("Canal de transferencia pronto.");
  });

  dataChannel.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
    void handleFileMessage(event);
  });
  dataChannel.addEventListener("close", disableTransfer);
}

async function startFileSend() {
  if (!pendingOutboundFile || !dataChannel || dataChannel.readyState !== "open") return;

  const file = pendingOutboundFile;
  pendingOutboundFile = undefined;
  setProgress(0);
  log(`Enviando ${file.name}...`);

  let offset = 0;
  let index = 0;
  while (offset < file.size) {
    if (transferCancelled) {
      dataChannel.send(JSON.stringify({ kind: "file-cancel" }));
      log("Envio cancelado.");
      resetTransferState();
      return;
    }

    await waitForBuffer();
    await waitIfPaused();
    const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
    const sha256 = await sha256Hex(chunk);
    dataChannel.send(JSON.stringify({ kind: "file-chunk", index, size: chunk.byteLength, sha256 }));
    dataChannel.send(chunk);
    offset += chunk.byteLength;
    index += 1;
    setProgress(Math.round((offset / file.size) * 100));
  }

  dataChannel.send(JSON.stringify({ kind: "file-done" }));
  log("Arquivo enviado.");
}

function offerNextFile() {
  if (!dataChannel || dataChannel.readyState !== "open") return;

  pendingOutboundFile = outboundQueue.shift();
  if (!pendingOutboundFile) {
    resetTransferState();
    log("Fila concluida.");
    return;
  }

  setProgress(0);
  log(`Aguardando aceite: ${pendingOutboundFile.name}`);
  dataChannel.send(
    JSON.stringify({
      kind: "file-offer",
      name: pendingOutboundFile.name,
      size: pendingOutboundFile.size,
      type: pendingOutboundFile.type
    })
  );
}

async function handleFileMessage(event: MessageEvent<string | ArrayBuffer>) {
  if (typeof event.data === "string") {
    const message = JSON.parse(event.data) as FileMessage;

    if (message.kind === "file-offer") {
      await prepareIncomingFile(message);
      return;
    }

    if (message.kind === "file-ready") {
      await startFileSend();
      return;
    }

    if (message.kind === "file-chunk") {
      pendingIncomingChunk = message;
      return;
    }

    if (message.kind === "file-rejected") {
      outboundQueue = [];
      pendingOutboundFile = undefined;
      resetTransferState();
      log("Transferencia recusada ou cancelada.");
      return;
    }

    if (message.kind === "file-cancel") {
      await cancelTransfer("Transferencia cancelada pelo outro lado.");
      return;
    }

    if (message.kind === "file-pause") {
      setTransferPaused(true);
      log("Transferencia pausada pelo outro lado.");
      return;
    }

    if (message.kind === "file-resume") {
      setTransferPaused(false);
      log("Transferencia retomada pelo outro lado.");
      return;
    }

    if (message.kind === "file-received") {
      offerNextFile();
      return;
    }

    if (message.kind === "file-done" && incomingFile) {
      await finishIncomingFile();
    }

    return;
  }

  if (!incomingFile) return;
  if (!pendingIncomingChunk) {
    log("Chunk recebido sem metadados de validacao.");
    return;
  }

  await writeIncomingChunk(event.data, pendingIncomingChunk);
  pendingIncomingChunk = undefined;
}

async function prepareIncomingFile(message: Extract<FileMessage, { kind: "file-offer" }>) {
  setProgress(0);

  const savePickerWindow = window as SavePickerWindow;
  if (savePickerWindow.showSaveFilePicker) {
    const item = document.createElement("li");
    item.textContent = `${message.name} (${formatBytes(message.size)}) pronto para receber. `;

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = "Salvar";
    item.append(saveButton);
    logList.prepend(item);

    saveButton.addEventListener(
      "click",
      async () => {
        try {
          const handle = await savePickerWindow.showSaveFilePicker?.({
            suggestedName: message.name
          });

          if (!handle) throw new Error("Save picker unavailable");

          incomingFile = {
            name: message.name,
            size: message.size,
            received: 0,
            writable: await handle.createWritable(),
            writeQueue: Promise.resolve()
          };

          saveButton.disabled = true;
          pauseTransferButton.disabled = false;
          cancelTransferButton.disabled = false;
          if (item.firstChild) item.firstChild.textContent = `Recebendo ${message.name}... `;
          dataChannel?.send(JSON.stringify({ kind: "file-ready" }));
        } catch {
          if (item.firstChild) item.firstChild.textContent = `Recebimento de ${message.name} cancelado. `;
          dataChannel?.send(JSON.stringify({ kind: "file-rejected" }));
        }
      },
      { once: true }
    );

    return;
  }

  incomingFile = {
    name: message.name,
    size: message.size,
    type: message.type,
    chunks: [],
    received: 0
  };
  log(`Recebendo ${message.name} em memoria...`);
  pauseTransferButton.disabled = false;
  cancelTransferButton.disabled = false;
  dataChannel?.send(JSON.stringify({ kind: "file-ready" }));
}

async function writeIncomingChunk(chunk: ArrayBuffer, expected: Extract<FileMessage, { kind: "file-chunk" }>) {
  if (!incomingFile) return;

  const actualHash = await sha256Hex(chunk);
  if (chunk.byteLength !== expected.size || actualHash !== expected.sha256) {
    pendingIncomingChunk = undefined;
    log(`Falha de integridade no chunk ${expected.index}. Transferencia interrompida.`);
    dataChannel?.send(JSON.stringify({ kind: "file-rejected" }));
    incomingFile = undefined;
    resetTransferState();
    return;
  }

  if (incomingFile.writable) {
    incomingFile.writeQueue = (incomingFile.writeQueue ?? Promise.resolve()).then(() =>
      incomingFile?.writable?.write(chunk)
    );
    await incomingFile.writeQueue;
  } else {
    incomingFile.chunks?.push(chunk);
  }

  incomingFile.received += chunk.byteLength;
  setProgress(Math.round((incomingFile.received / incomingFile.size) * 100));
}

async function finishIncomingFile() {
  if (!incomingFile) return;

  if (incomingFile.writable) {
    await incomingFile.writeQueue;
    await incomingFile.writable.close();
    log(`${incomingFile.name} salvo no disco.`);
    dataChannel?.send(JSON.stringify({ kind: "file-received" }));
    incomingFile = undefined;
    resetTransferState();
    setProgress(100);
    return;
  }

  if (incomingFile.chunks) {
    const blob = new Blob(incomingFile.chunks, { type: incomingFile.type });
    const url = URL.createObjectURL(blob);
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = url;
    link.download = incomingFile.name;
    link.textContent = `Baixar ${incomingFile.name}`;
    item.append(link);
    logList.prepend(item);
    dataChannel?.send(JSON.stringify({ kind: "file-received" }));
    incomingFile = undefined;
    resetTransferState();
    setProgress(100);
  }
}

async function cancelTransfer(message: string) {
  transferCancelled = true;
  setTransferPaused(false);
  outboundQueue = [];
  pendingOutboundFile = undefined;
  pendingIncomingChunk = undefined;

  if (incomingFile?.writable && "abort" in incomingFile.writable) {
    await incomingFile.writable.abort();
  }

  incomingFile = undefined;
  resetTransferState();
  log(message);
}

function waitForBuffer() {
  if (!dataChannel || dataChannel.bufferedAmount < chunkSize * 16) return Promise.resolve();

  return new Promise<void>((resolve) => {
    dataChannel?.addEventListener("bufferedamountlow", () => resolve(), { once: true });
  });
}

function waitIfPaused() {
  if (!transferPaused) return Promise.resolve();

  return new Promise<void>((resolve) => {
    resumeTransfer = resolve;
  });
}

function sendSignal(message: Record<string, unknown>) {
  ws?.send(JSON.stringify(message));
}

function setStatus(message: string, state: "idle" | "pending" | "active" | "error" = "idle") {
  statusText.textContent = message;
  connectionPill.dataset.state = state;
}

function setProgress(value: number) {
  progress.value = value;
  progressText.textContent = `${value}%`;
}

function disableTransfer() {
  fileInput.disabled = true;
  sendFileButton.disabled = true;
  pauseTransferButton.disabled = true;
  cancelTransferButton.disabled = true;
}

function resetTransferState() {
  setTransferPaused(false);
  pauseTransferButton.disabled = true;
  cancelTransferButton.disabled = true;
  sendFileButton.disabled = !dataChannel || dataChannel.readyState !== "open";
}

function setTransferPaused(paused: boolean) {
  transferPaused = paused;
  pauseTransferButton.textContent = paused ? "Continuar" : "Pausar";

  if (!paused && resumeTransfer) {
    resumeTransfer();
    resumeTransfer = undefined;
  }
}

function log(message: string) {
  const item = document.createElement("li");
  item.textContent = message;
  logList.prepend(item);
}

async function sha256Hex(buffer: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function queryElement<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}
