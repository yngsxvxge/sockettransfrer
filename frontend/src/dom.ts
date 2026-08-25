export type Dom = ReturnType<typeof createDom>;

export function createDom() {
  return {
    createSessionButton: query<HTMLButtonElement>("#createSession"),
    reconnectButton: query<HTMLButtonElement>("#reconnect"),
    joinForm: query<HTMLFormElement>("#joinForm"),
    sessionCodeInput: query<HTMLInputElement>("#sessionCode"),
    statusText: query<HTMLSpanElement>("#statusText"),
    codeText: query<HTMLElement>("#codeText"),
    copyCodeButton: query<HTMLButtonElement>("#copyCode"),
    connectionPill: query<HTMLElement>("#connectionPill"),
    fileInput: query<HTMLInputElement>("#fileInput"),
    fileLabel: query<HTMLSpanElement>("#fileLabel"),
    fileMeta: query<HTMLElement>("#fileMeta"),
    sendFileButton: query<HTMLButtonElement>("#sendFile"),
    pauseTransferButton: query<HTMLButtonElement>("#pauseTransfer"),
    cancelTransferButton: query<HTMLButtonElement>("#cancelTransfer"),
    progress: query<HTMLProgressElement>("#progress"),
    progressText: query<HTMLElement>("#progressText"),
    logList: query<HTMLUListElement>("#log")
  };
}

export function setStatus(dom: Dom, message: string, state: "idle" | "pending" | "active" | "error" = "idle") {
  dom.statusText.textContent = message;
  dom.connectionPill.dataset.state = state;
}

export function setProgress(dom: Dom, value: number) {
  dom.progress.value = value;
  dom.progressText.textContent = `${value}%`;
}

export function log(dom: Dom, message: string) {
  const item = document.createElement("li");
  item.textContent = message;
  dom.logList.prepend(item);
}

export function disableTransfer(dom: Dom) {
  dom.fileInput.disabled = true;
  dom.sendFileButton.disabled = true;
  dom.pauseTransferButton.disabled = true;
  dom.cancelTransferButton.disabled = true;
}

export function query<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}
