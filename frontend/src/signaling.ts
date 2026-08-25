import type { RtcSignal, SignalingMessage } from "./types";

type SignalingHandlers = {
  message: (message: SignalingMessage) => void;
  close: () => void;
};

export class SignalingClient {
  private socket?: WebSocket;

  constructor(private readonly wsUrl: string, private readonly handlers: SignalingHandlers) {}

  connect() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return this.socket;
    this.socket = new WebSocket(this.wsUrl);
    this.socket.addEventListener("message", (event: MessageEvent<string>) => {
      this.handlers.message(JSON.parse(event.data) as SignalingMessage);
    });
    this.socket.addEventListener("close", this.handlers.close);
    return this.socket;
  }

  whenOpen(callback: () => void) {
    if (this.socket?.readyState === WebSocket.OPEN) callback();
    else this.socket?.addEventListener("open", callback, { once: true });
  }

  send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendSignal(data: RtcSignal) {
    this.send({ type: "signal", data });
  }

  close() {
    this.socket?.close();
  }
}
