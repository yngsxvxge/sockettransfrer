import type { RtcSignal, TransferConfig } from "./types";

type WebRtcHandlers = {
  status: (state: RTCPeerConnectionState) => void;
  channel: (channel: RTCDataChannel) => void;
  signal: (signal: RtcSignal) => void;
};

export class PeerConnection {
  private connection?: RTCPeerConnection;
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(private readonly config: TransferConfig, private readonly handlers: WebRtcHandlers) {}

  prepare(isInitiator: boolean) {
    this.connection?.close();
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.connection = new RTCPeerConnection({ iceServers: this.config.iceServers });
    this.connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) this.handlers.signal({ kind: "ice", candidate: event.candidate.toJSON() });
    });
    this.connection.addEventListener("connectionstatechange", () => {
      if (this.connection) this.handlers.status(this.connection.connectionState);
    });
    this.connection.addEventListener("datachannel", (event) => this.handlers.channel(event.channel));
    if (isInitiator) {
      this.handlers.channel(this.connection.createDataChannel("files"));
      void this.createOffer();
    }
  }

  async handleSignal(signal: RtcSignal) {
    if (!this.connection) this.prepare(false);
    if (!this.connection) return;
    if (signal.kind === "offer") {
      await this.connection.setRemoteDescription(signal.description);
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
      const answer = await this.connection.createAnswer();
      await this.connection.setLocalDescription(answer);
      this.handlers.signal({ kind: "answer", description: answer });
    } else if (signal.kind === "answer") {
      await this.connection.setRemoteDescription(signal.description);
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
    } else {
      if (!this.remoteDescriptionSet) this.pendingCandidates.push(signal.candidate);
      else await this.connection.addIceCandidate(signal.candidate);
    }
  }

  close() {
    this.connection?.close();
    this.connection = undefined;
  }

  private async flushCandidates() {
    if (!this.connection) return;
    for (const candidate of this.pendingCandidates.splice(0)) await this.connection.addIceCandidate(candidate);
  }

  private async createOffer() {
    if (!this.connection) return;
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    this.handlers.signal({ kind: "offer", description: offer });
  }
}
