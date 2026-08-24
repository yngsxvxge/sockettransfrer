const createSessionButton = document.querySelector("#createSession");
const joinForm = document.querySelector("#joinForm");
const sessionCodeInput = document.querySelector("#sessionCode");
const statusText = document.querySelector("#statusText");
const codeText = document.querySelector("#codeText");
const fileInput = document.querySelector("#fileInput");
const sendFileButton = document.querySelector("#sendFile");
const progress = document.querySelector("#progress");
const logList = document.querySelector("#log");

const chunkSize = 16 * 1024;
let ws;
let peerConnection;
let dataChannel;
let sessionCode = "";
let incomingFile;
let pendingOutboundFile;

createSessionButton.addEventListener("click", () => {
  connectSocket();
  ws.addEventListener("open", () => sendSignal({ type: "create" }), { once: true });
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = sessionCodeInput.value.trim().toUpperCase();
  if (!code) return;

  connectSocket();
  ws.addEventListener("open", () => sendSignal({ type: "join", code }), { once: true });
});

sendFileButton.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!file || !dataChannel || dataChannel.readyState !== "open") return;

  pendingOutboundFile = file;
  sendFileButton.disabled = true;
  progress.value = 0;
  log(`Aguardando o outro lado aceitar ${file.name}...`);
  dataChannel.send(JSON.stringify({ kind: "file-offer", name: file.name, size: file.size, type: file.type }));
});

function connectSocket() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;

  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  setStatus("Conectando...");

  ws.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "created") {
      sessionCode = message.code;
      codeText.textContent = sessionCode;
      setStatus("Sessao criada. Aguardando outra pessoa...");
      return;
    }

    if (message.type === "joined") {
      sessionCode = message.code;
      codeText.textContent = sessionCode;
      setStatus("Sessao encontrada. Conectando WebRTC...");
      preparePeerConnection(false);
      return;
    }

    if (message.type === "peer-joined") {
      setStatus("Pessoa conectada. Criando canal...");
      preparePeerConnection(true);
      return;
    }

    if (message.type === "signal") {
      await handleRtcSignal(message.data);
      return;
    }

    if (message.type === "peer-left") {
      setStatus("A outra pessoa saiu.");
      disableTransfer();
      return;
    }

    if (message.type === "error") {
      setStatus(message.message);
    }
  });

  ws.addEventListener("close", () => {
    setStatus("WebSocket desconectado.");
    disableTransfer();
  });
}

function preparePeerConnection(isInitiator) {
  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  peerConnection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendSignal({ type: "signal", data: { kind: "ice", candidate: event.candidate } });
    }
  });

  peerConnection.addEventListener("connectionstatechange", () => {
    setStatus(`WebRTC: ${peerConnection.connectionState}`);
  });

  peerConnection.addEventListener("datachannel", (event) => setupDataChannel(event.channel));

  if (isInitiator) {
    setupDataChannel(peerConnection.createDataChannel("files"));
    createOffer();
  }
}

async function createOffer() {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  sendSignal({ type: "signal", data: { kind: "offer", description: offer } });
}

async function handleRtcSignal(data) {
  if (!peerConnection) preparePeerConnection(false);

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

function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.binaryType = "arraybuffer";
  dataChannel.bufferedAmountLowThreshold = chunkSize * 4;

  dataChannel.addEventListener("open", () => {
    setStatus("Conectado. Pode enviar arquivo.");
    fileInput.disabled = false;
    sendFileButton.disabled = false;
  });

  dataChannel.addEventListener("message", handleFileMessage);
  dataChannel.addEventListener("close", disableTransfer);
}

async function startFileSend() {
  if (!pendingOutboundFile || !dataChannel || dataChannel.readyState !== "open") return;

  const file = pendingOutboundFile;
  pendingOutboundFile = undefined;
  progress.value = 0;
  log(`Enviando ${file.name}...`);

  let offset = 0;
  while (offset < file.size) {
    await waitForBuffer();
    const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
    dataChannel.send(chunk);
    offset += chunk.byteLength;
    progress.value = Math.round((offset / file.size) * 100);
  }

  dataChannel.send(JSON.stringify({ kind: "file-done" }));
  sendFileButton.disabled = false;
  log("Arquivo enviado.");
}

async function handleFileMessage(event) {
  if (typeof event.data === "string") {
    const message = JSON.parse(event.data);

    if (message.kind === "file-offer") {
      await prepareIncomingFile(message);
      return;
    }

    if (message.kind === "file-ready") {
      await startFileSend();
      return;
    }

    if (message.kind === "file-rejected") {
      pendingOutboundFile = undefined;
      sendFileButton.disabled = false;
      log("Transferencia recusada ou cancelada.");
      return;
    }

    if (message.kind === "file-done" && incomingFile) {
      await finishIncomingFile();
    }

    return;
  }

  if (!incomingFile) return;

  await writeIncomingChunk(event.data);
}

async function prepareIncomingFile(message) {
  progress.value = 0;

  if ("showSaveFilePicker" in window) {
    const item = document.createElement("li");
    item.textContent = `${message.name} esta pronto para receber. `;

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = "Salvar";
    item.append(saveButton);
    logList.prepend(item);

    saveButton.addEventListener(
      "click",
      async () => {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: message.name
          });

          incomingFile = {
            name: message.name,
            size: message.size,
            received: 0,
            writable: await handle.createWritable(),
            writeQueue: Promise.resolve()
          };

          saveButton.disabled = true;
          item.firstChild.textContent = `Recebendo ${message.name}... `;
          dataChannel.send(JSON.stringify({ kind: "file-ready" }));
        } catch {
          item.firstChild.textContent = `Recebimento de ${message.name} cancelado. `;
          dataChannel.send(JSON.stringify({ kind: "file-rejected" }));
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
  dataChannel.send(JSON.stringify({ kind: "file-ready" }));
}

async function writeIncomingChunk(chunk) {
  if (incomingFile.writable) {
    incomingFile.writeQueue = incomingFile.writeQueue.then(() => incomingFile.writable.write(chunk));
    await incomingFile.writeQueue;
  } else {
    incomingFile.chunks.push(chunk);
  }

  incomingFile.received += chunk.byteLength;
  progress.value = Math.round((incomingFile.received / incomingFile.size) * 100);
}

async function finishIncomingFile() {
  if (incomingFile.writable) {
    await incomingFile.writeQueue;
    await incomingFile.writable.close();
    log(`${incomingFile.name} salvo no disco.`);
    incomingFile = undefined;
    progress.value = 100;
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
    incomingFile = undefined;
    progress.value = 100;
  }
}

function waitForBuffer() {
  if (dataChannel.bufferedAmount < chunkSize * 16) return Promise.resolve();

  return new Promise((resolve) => {
    dataChannel.addEventListener("bufferedamountlow", resolve, { once: true });
  });
}

function sendSignal(message) {
  ws.send(JSON.stringify(message));
}

function setStatus(message) {
  statusText.textContent = message;
}

function disableTransfer() {
  fileInput.disabled = true;
  sendFileButton.disabled = true;
}

function log(message) {
  const item = document.createElement("li");
  item.textContent = message;
  logList.prepend(item);
}
