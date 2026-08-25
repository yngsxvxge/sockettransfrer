import type { TransferConfig } from "./types";

export async function loadConfig(): Promise<TransferConfig> {
  const response = await fetch("/config.json");
  if (!response.ok) throw new Error("Nao foi possivel carregar a configuracao.");
  return (await response.json()) as TransferConfig;
}
