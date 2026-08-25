export type SignalingMessage =
  | { type: "created"; code: string; expiresAt: number; participantId: string }
  | { type: "joined"; code: string; expiresAt: number; participantId: string; peers: string[] }
  | { type: "peer-joined"; peerId: string }
  | { type: "peer-left"; peerId: string }
  | { type: "session-expired"; code: string }
  | { type: "signal"; from: string; data: RtcSignal }
  | { type: "error"; message: string };

export type RtcSignal =
  | { kind: "offer"; description: RTCSessionDescriptionInit }
  | { kind: "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export type FileMessage =
  | { kind: "file-offer"; name: string; size: number; type: string }
  | { kind: "file-chunk"; index: number; size: number; sha256: string }
  | { kind: "file-ready" }
  | { kind: "file-rejected" }
  | { kind: "file-cancel" }
  | { kind: "file-pause" }
  | { kind: "file-resume" }
  | { kind: "file-received" }
  | { kind: "file-done" };

export type IncomingFile = {
  name: string;
  size: number;
  type?: string;
  received: number;
  chunks?: ArrayBuffer[];
  writable?: FileSystemWritableFileStream;
  writeQueue?: Promise<void>;
};

export type TransferConfig = { iceServers: RTCIceServer[] };

export type SavePickerWindow = Window &
  typeof globalThis & {
    showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
  };
