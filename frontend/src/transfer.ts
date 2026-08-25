import { disableTransfer, log, setProgress, type Dom } from "./dom";
import { formatBytes, sha256Hex } from "./format";
import type { FileMessage, IncomingFile, SavePickerWindow } from "./types";

const chunkSize = 16 * 1024;

export class TransferManager {
  private channel?: RTCDataChannel;
  private incomingFile?: IncomingFile;
  private pendingIncomingChunk?: Extract<FileMessage, { kind: "file-chunk" }>;
  private outboundQueue: File[] = [];
  private pendingOutboundFile?: File;
  private transferCancelled = false;
  private transferPaused = false;
  private resumeTransfer?: () => void;

  constructor(private readonly dom: Dom) {}

  attachChannel(channel: RTCDataChannel) {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = chunkSize * 4;
    channel.addEventListener("open", () => {
      this.dom.fileInput.disabled = false;
      this.dom.sendFileButton.disabled = false;
      log(this.dom, "Canal de transferencia pronto.");
    });
    channel.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => void this.handleMessage(event));
    channel.addEventListener("close", () => disableTransfer(this.dom));
  }

  send(files: File[]) {
    if (!files.length || !this.channel || this.channel.readyState !== "open") return;
    this.outboundQueue = files;
    this.transferCancelled = false;
    this.setPaused(false);
    this.dom.sendFileButton.disabled = true;
    this.dom.pauseTransferButton.disabled = false;
    this.dom.cancelTransferButton.disabled = false;
    setProgress(this.dom, 0);
    log(this.dom, `Fila criada com ${files.length} arquivo${files.length === 1 ? "" : "s"}.`);
    this.offerNextFile();
  }

  cancel(message = "Transferencia cancelada.") {
    void this.cancelTransfer(message);
    this.channel?.send(JSON.stringify({ kind: "file-cancel" }));
  }

  togglePause() {
    if (this.transferPaused) {
      this.setPaused(false);
      this.channel?.send(JSON.stringify({ kind: "file-resume" }));
      log(this.dom, "Transferencia retomada.");
    } else {
      this.setPaused(true);
      this.channel?.send(JSON.stringify({ kind: "file-pause" }));
      log(this.dom, "Transferencia pausada.");
    }
  }

  private async startFileSend() {
    if (!this.pendingOutboundFile || !this.channel || this.channel.readyState !== "open") return;
    const file = this.pendingOutboundFile;
    this.pendingOutboundFile = undefined;
    setProgress(this.dom, 0);
    log(this.dom, `Enviando ${file.name}...`);
    let offset = 0;
    let index = 0;
    while (offset < file.size) {
      if (this.transferCancelled) return;
      await this.waitForBuffer();
      await this.waitIfPaused();
      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
      const sha256 = await sha256Hex(chunk);
      this.channel.send(JSON.stringify({ kind: "file-chunk", index, size: chunk.byteLength, sha256 }));
      this.channel.send(chunk);
      offset += chunk.byteLength;
      index += 1;
      setProgress(this.dom, Math.round((offset / file.size) * 100));
    }
    this.channel.send(JSON.stringify({ kind: "file-done" }));
    log(this.dom, "Arquivo enviado.");
  }

  private offerNextFile() {
    if (!this.channel || this.channel.readyState !== "open") return;
    this.pendingOutboundFile = this.outboundQueue.shift();
    if (!this.pendingOutboundFile) {
      this.resetState();
      log(this.dom, "Fila concluida.");
      return;
    }
    setProgress(this.dom, 0);
    log(this.dom, `Aguardando aceite: ${this.pendingOutboundFile.name}`);
    this.channel.send(JSON.stringify({ kind: "file-offer", name: this.pendingOutboundFile.name, size: this.pendingOutboundFile.size, type: this.pendingOutboundFile.type }));
  }

  private async handleMessage(event: MessageEvent<string | ArrayBuffer>) {
    if (typeof event.data !== "string") {
      if (!this.incomingFile || !this.pendingIncomingChunk) return;
      await this.writeIncomingChunk(event.data, this.pendingIncomingChunk);
      this.pendingIncomingChunk = undefined;
      return;
    }
    const message = JSON.parse(event.data) as FileMessage;
    if (message.kind === "file-offer") return this.prepareIncomingFile(message);
    if (message.kind === "file-ready") return void this.startFileSend();
    if (message.kind === "file-chunk") {
      this.pendingIncomingChunk = message;
      return;
    }
    if (message.kind === "file-rejected") {
      this.outboundQueue = [];
      this.pendingOutboundFile = undefined;
      this.resetState();
      log(this.dom, "Transferencia recusada ou cancelada.");
    } else if (message.kind === "file-cancel") {
      await this.cancelTransfer("Transferencia cancelada pelo outro lado.");
    } else if (message.kind === "file-pause") {
      this.setPaused(true);
      log(this.dom, "Transferencia pausada pelo outro lado.");
    } else if (message.kind === "file-resume") {
      this.setPaused(false);
      log(this.dom, "Transferencia retomada pelo outro lado.");
    } else if (message.kind === "file-received") {
      this.offerNextFile();
    } else if (message.kind === "file-done" && this.incomingFile) {
      await this.finishIncomingFile();
    }
  }

  private async prepareIncomingFile(message: Extract<FileMessage, { kind: "file-offer" }>) {
    setProgress(this.dom, 0);
    const pickerWindow = window as SavePickerWindow;
    if (pickerWindow.showSaveFilePicker) {
      const item = document.createElement("li");
      item.textContent = `${message.name} (${formatBytes(message.size)}) pronto para receber. `;
      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.textContent = "Salvar";
      item.append(saveButton);
      this.dom.logList.prepend(item);
      saveButton.addEventListener("click", async () => {
        try {
          const handle = await pickerWindow.showSaveFilePicker?.({ suggestedName: message.name });
          if (!handle) throw new Error("Save picker unavailable");
          this.incomingFile = { name: message.name, size: message.size, received: 0, writable: await handle.createWritable(), writeQueue: Promise.resolve() };
          saveButton.disabled = true;
          this.enableControls();
          if (item.firstChild) item.firstChild.textContent = `Recebendo ${message.name}... `;
          this.channel?.send(JSON.stringify({ kind: "file-ready" }));
        } catch {
          if (item.firstChild) item.firstChild.textContent = `Recebimento de ${message.name} cancelado. `;
          this.channel?.send(JSON.stringify({ kind: "file-rejected" }));
        }
      }, { once: true });
      return;
    }
    this.incomingFile = { name: message.name, size: message.size, type: message.type, chunks: [], received: 0 };
    log(this.dom, `Recebendo ${message.name} em memoria...`);
    this.enableControls();
    this.channel?.send(JSON.stringify({ kind: "file-ready" }));
  }

  private async writeIncomingChunk(chunk: ArrayBuffer, expected: Extract<FileMessage, { kind: "file-chunk" }>) {
    if (!this.incomingFile) return;
    const actualHash = await sha256Hex(chunk);
    if (chunk.byteLength !== expected.size || actualHash !== expected.sha256) {
      log(this.dom, `Falha de integridade no chunk ${expected.index}. Transferencia interrompida.`);
      this.channel?.send(JSON.stringify({ kind: "file-rejected" }));
      this.incomingFile = undefined;
      this.resetState();
      return;
    }
    if (this.incomingFile.writable) {
      this.incomingFile.writeQueue = (this.incomingFile.writeQueue ?? Promise.resolve()).then(() => this.incomingFile?.writable?.write(chunk));
      await this.incomingFile.writeQueue;
    } else this.incomingFile.chunks?.push(chunk);
    this.incomingFile.received += chunk.byteLength;
    setProgress(this.dom, Math.round((this.incomingFile.received / this.incomingFile.size) * 100));
  }

  private async finishIncomingFile() {
    if (!this.incomingFile) return;
    if (this.incomingFile.writable) {
      await this.incomingFile.writeQueue;
      await this.incomingFile.writable.close();
      log(this.dom, `${this.incomingFile.name} salvo no disco.`);
    } else if (this.incomingFile.chunks) {
      const blob = new Blob(this.incomingFile.chunks, { type: this.incomingFile.type });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = this.incomingFile.name;
      link.textContent = `Baixar ${this.incomingFile.name}`;
      const item = document.createElement("li");
      item.append(link);
      this.dom.logList.prepend(item);
    }
    this.channel?.send(JSON.stringify({ kind: "file-received" }));
    this.incomingFile = undefined;
    this.resetState();
    setProgress(this.dom, 100);
  }

  private async cancelTransfer(message: string) {
    this.transferCancelled = true;
    this.setPaused(false);
    this.outboundQueue = [];
    this.pendingOutboundFile = undefined;
    this.pendingIncomingChunk = undefined;
    if (this.incomingFile?.writable && "abort" in this.incomingFile.writable) await this.incomingFile.writable.abort();
    this.incomingFile = undefined;
    this.resetState();
    log(this.dom, message);
  }

  private waitForBuffer() {
    if (!this.channel || this.channel.bufferedAmount < chunkSize * 16) return Promise.resolve();
    return new Promise<void>((resolve) => this.channel?.addEventListener("bufferedamountlow", () => resolve(), { once: true }));
  }

  private waitIfPaused() {
    if (!this.transferPaused) return Promise.resolve();
    return new Promise<void>((resolve) => { this.resumeTransfer = resolve; });
  }

  private enableControls() {
    this.dom.pauseTransferButton.disabled = false;
    this.dom.cancelTransferButton.disabled = false;
  }

  private resetState() {
    this.setPaused(false);
    this.dom.pauseTransferButton.disabled = true;
    this.dom.cancelTransferButton.disabled = true;
    this.dom.sendFileButton.disabled = !this.channel || this.channel.readyState !== "open";
  }

  private setPaused(paused: boolean) {
    this.transferPaused = paused;
    this.dom.pauseTransferButton.textContent = paused ? "Continuar" : "Pausar";
    if (!paused && this.resumeTransfer) {
      this.resumeTransfer();
      this.resumeTransfer = undefined;
    }
  }
}
