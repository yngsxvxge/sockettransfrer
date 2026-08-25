import type { ClientRuntimeConfig } from "./types";

export async function loadConfig(): Promise<ClientRuntimeConfig> {
  const configuredApiUrl = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
  const response = await fetch(`${configuredApiUrl}/config.json`);
  if (!response.ok) throw new Error("Nao foi possivel carregar a configuracao.");
  const config = (await response.json()) as ClientRuntimeConfig;
  const apiUrl = configuredApiUrl || config.apiUrl || location.origin;
  const configuredWsUrl = import.meta.env.VITE_WS_URL || config.wsUrl;
  const apiOrigin = new URL(apiUrl);
  const wsProtocol = apiOrigin.protocol === "https:" ? "wss:" : "ws:";
  return {
    ...config,
    apiUrl: apiOrigin.origin,
    wsUrl: configuredWsUrl || `${wsProtocol}//${apiOrigin.host}/ws`
  };
}
