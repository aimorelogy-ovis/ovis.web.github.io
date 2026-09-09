export const PENDING_CONFIG_APPLICATION_KEY = "ovis_pending_config_application";

export interface PendingConfigApplication {
  device_id: string;
  api_base_url: string;
  task_id: number;
  target_revision: string;
  started_at: number;
  reconnect_required?: boolean;
  reboot_required?: boolean;
}

function isPendingConfigApplication(value: unknown): value is PendingConfigApplication {
  if (typeof value !== "object" || value === null) return false;
  const pending = value as Record<string, unknown>;
  return (
    typeof pending.device_id === "string" &&
    pending.device_id.length > 0 &&
    typeof pending.api_base_url === "string" &&
    pending.api_base_url.length > 0 &&
    typeof pending.task_id === "number" &&
    Number.isInteger(pending.task_id) &&
    typeof pending.target_revision === "string" &&
    pending.target_revision.length > 0 &&
    typeof pending.started_at === "number" &&
    Number.isFinite(pending.started_at) &&
    (pending.reconnect_required === undefined ||
      typeof pending.reconnect_required === "boolean") &&
    (pending.reboot_required === undefined ||
      typeof pending.reboot_required === "boolean")
  );
}

export function readPendingConfigApplication(): PendingConfigApplication | null {
  if (typeof window === "undefined") return null;
  const stored = window.sessionStorage.getItem(PENDING_CONFIG_APPLICATION_KEY);
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (isPendingConfigApplication(value)) return value;
  } catch {
    // Invalid recovery data is discarded below.
  }
  window.sessionStorage.removeItem(PENDING_CONFIG_APPLICATION_KEY);
  return null;
}

export function writePendingConfigApplication(
  pending: PendingConfigApplication,
): void {
  window.sessionStorage.setItem(
    PENDING_CONFIG_APPLICATION_KEY,
    JSON.stringify(pending),
  );
}

export function clearPendingConfigApplication(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(PENDING_CONFIG_APPLICATION_KEY);
}
