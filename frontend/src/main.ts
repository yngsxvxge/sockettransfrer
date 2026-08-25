import { loadConfig } from "./config";
import { createDom, disableTransfer, log, setStatus } from "./dom";
import { formatBytes } from "./format";
import { SignalingClient } from "./signaling";
import type { SignalingMessage } from "./types";
import { TransferManager } from "./transfer";
import { PeerConnection } from "./webrtc";

const dom = createDom();
const transfer = new TransferManager(dom);
let sessionCode = "";
let signaling: SignalingClient;
let peer: PeerConnection;

void initialize();

async function initialize() {
  try {
    const config = await loadConfig();
    signaling = new SignalingClient({ message: handleSignalingMessage, close: handleSocketClose });
    peer = new PeerConnection(config, {
      signal: (signal) => signaling.sendSignal(signal),
      channel: (channel) => transfer.attachChannel(channel),
      status: (state) => setStatus(dom, `WebRTC: ${state}`, state === "connected" ? "active" : state === "failed" ? "error" : "pending")
    });
    bindUi();
  } catch (error) {
    setStatus(dom, error instanceof Error ? error.message : "Erro ao iniciar aplicacao.", "error");
  }
}

function bindUi() {
  dom.createSessionButton.addEventListener("click", () => {
    signaling.connect();
    signaling.whenOpen(() => signaling.send({ type: "create" }));
  });
  dom.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = dom.sessionCodeInput.value.trim().toUpperCase();
    if (!code) return;
    signaling.connect();
    signaling.whenOpen(() => signaling.send({ type: "join", code }));
  });
  dom.fileInput.addEventListener("change", () => {
    const files = [...(dom.fileInput.files ?? [])];
    const totalSize = files.reduce((total, file) => total + file.size, 0);
    dom.fileLabel.textContent = files.length === 0 ? "Selecionar arquivo" : files.length === 1 ? files[0].name : `${files.length} arquivos`;
    dom.fileMeta.textContent = files.length ? formatBytes(totalSize) : "Nenhum arquivo selecionado";
  });
  dom.sendFileButton.addEventListener("click", () => transfer.send([...(dom.fileInput.files ?? [])]));
  dom.pauseTransferButton.addEventListener("click", () => transfer.togglePause());
  dom.cancelTransferButton.addEventListener("click", () => transfer.cancel());
}

async function handleSignalingMessage(message: SignalingMessage) {
  if (message.type === "created" || message.type === "joined") {
    sessionCode = message.code;
    dom.codeText.textContent = sessionCode;
    if (message.type === "created") {
      setStatus(dom, "Aguardando par", "pending");
      log(dom, `Sessao ${sessionCode} criada.`);
    } else {
      setStatus(dom, "Conectando WebRTC", "pending");
      peer.prepare(false);
    }
  } else if (message.type === "peer-joined") {
    setStatus(dom, "Criando canal", "pending");
    peer.prepare(true);
  } else if (message.type === "signal") {
    await peer.handleSignal(message.data);
  } else if (message.type === "peer-left") {
    setStatus(dom, "Par desconectado", "error");
    disableTransfer(dom);
  } else if (message.type === "session-expired") {
    sessionCode = "";
    dom.codeText.textContent = "";
    setStatus(dom, "Sessao expirada", "error");
    disableTransfer(dom);
    log(dom, "Sessao expirada. Crie uma nova sessao para continuar.");
  } else if (message.type === "error") {
    setStatus(dom, message.message, "error");
  }
}

function handleSocketClose() {
  setStatus(dom, "WebSocket desconectado", "error");
  disableTransfer(dom);
}
