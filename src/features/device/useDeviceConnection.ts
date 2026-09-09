import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearPendingConfigApplication,
  readPendingConfigApplication,
} from "../config/config.session";
import { reconnectDeviceByIdentity } from "../config/config.recovery";
import {
  clearPendingModelTask,
  readPendingModelTask,
} from "../models/model.session";
import {
  buildDeviceApiBaseUrl,
  DeviceConnectionError,
  discoverDevices,
  fetchDeviceInfo,
  isSupportedBrowser,
  resetDeviceNetwork,
} from "./device.api";
import {
  closeOvisUsbDevice,
  discoverAuthorizedOvisUsbDevices,
  forgetOvisSubnet,
  getAuthorizedOvisUsbDevices,
  isWebUsbAvailable,
  onWebUsbDeviceChange,
  rememberOvisSubnet,
  requestOvisUsbDevice,
} from "./webusb.api";
import type {
  DeviceConnectionFailure,
  DeviceConnectionErrorCode,
  DiscoveryReport,
  DeviceState,
  DiscoveredOvisDevice,
  InitializedDevice,
  OvisDeviceInfo,
  UseDeviceConnection,
} from "./device.types";

const HEARTBEAT_INTERVAL_MS = 3_000;
const MAX_CONSECUTIVE_FAILURES = 2;
const LAST_DEVICE_ADDRESS_KEY = "ovis_last_device_api_base_url";

interface ConnectedTarget {
  apiBaseUrl: string;
  deviceId: string;
}

const readLastSuccessfulAddress = () => {
  try {
    return window.sessionStorage.getItem(LAST_DEVICE_ADDRESS_KEY);
  } catch {
    return null;
  }
};

const writeLastSuccessfulAddress = (apiBaseUrl: string) => {
  try {
    window.sessionStorage.setItem(LAST_DEVICE_ADDRESS_KEY, apiBaseUrl);
  } catch {
    // Discovery still works when session storage is unavailable.
  }
};

const clearLastSuccessfulAddress = () => {
  try {
    window.sessionStorage.removeItem(LAST_DEVICE_ADDRESS_KEY);
  } catch {
    // The in-memory discovery hint is still cleared when storage is unavailable.
  }
};

const rememberConnectedAddress = (deviceId: string, apiBaseUrl: string) => {
  try {
    const octets = new URL(apiBaseUrl).hostname.split(".");
    if (
      octets.length === 4 &&
      octets[0] === "192" &&
      octets[1] === "168" &&
      Number.isInteger(Number(octets[2]))
    ) {
      rememberOvisSubnet(deviceId, Number(octets[2]));
    }
  } catch {
    // A malformed hint must not affect a successful connection.
  }
};

const reportErrorCode = (
  report: DiscoveryReport,
): DeviceConnectionErrorCode | null => {
  if (report.failureReason === "permission-denied") {
    return "LOCAL_NETWORK_PERMISSION_DENIED";
  }
  if (report.failureReason === "browser-blocked") {
    return "LOCAL_NETWORK_BLOCKED";
  }
  if (report.failureReason === "network-error") {
    return "SCAN_NETWORK_ERROR";
  }
  return report.devices.length === 0 ? "NO_DEVICE_FOUND" : null;
};

const toUninitializedDevice = (
  usbSession: Awaited<ReturnType<typeof getAuthorizedOvisUsbDevices>>[number],
): DiscoveredOvisDevice => ({
  initialization: "uninitialized",
  source: "webusb",
  deviceId: usbSession.info.device_id,
  usbSession,
  info: usbSession.info,
});

function mergeDiscoveredDevices(
  initialized: InitializedDevice[],
  uninitialized: DiscoveredOvisDevice[],
): DiscoveredOvisDevice[] {
  const devicesById = new Map<string, DiscoveredOvisDevice>();
  uninitialized.forEach((entry) => devicesById.set(entry.deviceId, entry));
  initialized.forEach((entry) => devicesById.set(entry.deviceId, entry));
  return [...devicesById.values()];
}

export function useDeviceConnection(): UseDeviceConnection {
  const browserSupported = isSupportedBrowser();
  const startupPending = useMemo(
    () => readPendingConfigApplication() ?? readPendingModelTask(),
    [],
  );
  const [state, setState] = useState<DeviceState>(
    startupPending ? "recovering" : browserSupported ? "idle" : "error",
  );
  const [devices, setDevices] = useState<DiscoveredOvisDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [device, setDevice] = useState<OvisDeviceInfo | null>(null);
  const [error, setError] = useState<DeviceConnectionErrorCode | null>(
    startupPending || browserSupported ? null : "UNSUPPORTED_BROWSER",
  );
  const [connectedAt, setConnectedAt] = useState<Date | null>(null);
  const [applicationLocked, setApplicationLockedState] = useState(
    startupPending !== null,
  );
  const [discoveryReport, setDiscoveryReport] =
    useState<DiscoveryReport | null>(null);
  const [scanInProgress, setScanInProgress] = useState(false);
  const [connectionFailure, setConnectionFailure] =
    useState<DeviceConnectionFailure | null>(null);
  const [usbPreflightReady, setUsbPreflightReady] = useState(
    !isWebUsbAvailable(),
  );
  const [usbAuthorizationPending, setUsbAuthorizationPending] = useState(false);
  const [usbIssue, setUsbIssue] = useState<string | null>(null);
  const applicationLockedRef = useRef(startupPending !== null);
  const operationGeneration = useRef(0);
  const scanController = useRef<AbortController | null>(null);
  const connectController = useRef<AbortController | null>(null);
  const devicesRef = useRef<DiscoveredOvisDevice[]>([]);
  const connectedTarget = useRef<ConnectedTarget | null>(null);
  const lastSuccessfulAddress = useRef<string | null>(
    readLastSuccessfulAddress(),
  );
  const manualUsbFallbackRef = useRef(false);

  const updateDevices = useCallback((nextDevices: DiscoveredOvisDevice[]) => {
    devicesRef.current = nextDevices;
    setDevices(nextDevices);
  }, []);

  const setApplicationLocked = useCallback((locked: boolean) => {
    applicationLockedRef.current = locked;
    setApplicationLockedState(locked);
  }, []);

  const adoptRecoveredDevice = useCallback(
    (apiBaseUrl: string, info: OvisDeviceInfo) => {
      const recoveredDevice: InitializedDevice = {
        initialization: "initialized",
        source: "network",
        deviceId: info.device_id,
        ipAddress: new URL(apiBaseUrl).hostname,
        apiBaseUrl,
        info,
        status: "online",
      };
      const withoutRecovered = devicesRef.current.filter(
        (entry) => entry.deviceId !== info.device_id,
      );
      updateDevices([recoveredDevice, ...withoutRecovered]);
      setSelectedDeviceId(info.device_id);
      setDevice(info);
      setError(null);
      setConnectedAt(new Date());
      connectedTarget.current = { apiBaseUrl, deviceId: info.device_id };
      lastSuccessfulAddress.current = apiBaseUrl;
      writeLastSuccessfulAddress(apiBaseUrl);
      rememberConnectedAddress(info.device_id, apiBaseUrl);
      setConnectionFailure(null);
      setState("connected");
    },
    [updateDevices],
  );

  const selectedDevice = useMemo(
    () =>
      devices.find((entry) => entry.deviceId === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  const initializedDevices = useMemo(
    () =>
      devices.filter(
        (entry): entry is InitializedDevice =>
          entry.initialization === "initialized",
      ),
    [devices],
  );

  useEffect(() => {
    if (!isWebUsbAvailable()) return;
    let active = true;
    void discoverAuthorizedOvisUsbDevices()
      .then((report) => {
        if (!active) {
          void Promise.allSettled(report.devices.map(closeOvisUsbDevice));
          return;
        }
        manualUsbFallbackRef.current = report.devices.length === 0;
        setUsbIssue(report.errors.length > 0 ? report.errors.join(" · ") : null);
        void Promise.allSettled(report.devices.map(closeOvisUsbDevice));
      })
      .catch((nextError) => {
        if (active) {
          setUsbIssue(nextError instanceof Error ? nextError.message : String(nextError));
          manualUsbFallbackRef.current = true;
        }
      })
      .finally(() => {
        if (active) setUsbPreflightReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!startupPending) return;
    const controller = new AbortController();
    operationGeneration.current += 1;
    setState("recovering");
    setApplicationLocked(true);

    void reconnectDeviceByIdentity(startupPending, controller.signal)
      .then((recovered) => {
        if (controller.signal.aborted) return;
        adoptRecoveredDevice(recovered.apiBaseUrl, recovered.info);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if ("target_revision" in startupPending) {
          clearPendingConfigApplication();
        } else {
          clearPendingModelTask();
        }
        setApplicationLocked(false);
        setError("NETWORK_ERROR");
        setState("error");
      });

    return () => controller.abort();
  }, [adoptRecoveredDevice, setApplicationLocked, startupPending]);

  const scan = useCallback(async () => {
    if (applicationLockedRef.current) return;
    scanController.current?.abort();
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    connectedTarget.current = null;

    if (!isSupportedBrowser()) {
      setState("error");
      setDevice(null);
      setConnectedAt(null);
      setError("UNSUPPORTED_BROWSER");
      setScanInProgress(false);
      return;
    }

    const controller = new AbortController();
    scanController.current = controller;
    setScanInProgress(true);
    setState("scanning");
    setSelectedDeviceId(null);
    setDevice(null);
    setConnectedAt(null);
    setError(null);
    setUsbIssue(null);
    setDiscoveryReport(null);
    setConnectionFailure(null);
    updateDevices([]);

    const shouldRequestUsbDevice = manualUsbFallbackRef.current;
    setUsbAuthorizationPending(shouldRequestUsbDevice);

    const usbDiscovery = discoverAuthorizedOvisUsbDevices().catch(
      (discoveryFailure: unknown) => ({
        devices: [],
        errors: [
          discoveryFailure instanceof Error
            ? discoveryFailure.message
            : String(discoveryFailure),
        ],
      }),
    );
    const requestedUsbDevice = shouldRequestUsbDevice
      ? requestOvisUsbDevice()
          .then((session) => ({ session, error: null as string | null }))
          .catch((requestError: unknown) => ({
            session: null,
            error:
              requestError instanceof DOMException &&
              requestError.name === "NotFoundError"
                ? null
                : requestError instanceof Error
                  ? requestError.message
                  : String(requestError),
          }))
      : Promise.resolve({ session: null, error: null as string | null });
    const networkDiscovery = discoverDevices(
      controller.signal,
      lastSuccessfulAddress.current,
      {
        onDevice: (discoveredDevice) => {
          if (
            controller.signal.aborted ||
            operationGeneration.current !== generation
          ) {
            return;
          }
          const initialized = devicesRef.current.filter(
            (entry): entry is InitializedDevice =>
              entry.initialization === "initialized" &&
              entry.deviceId !== discoveredDevice.deviceId,
          );
          const uninitialized = devicesRef.current.filter(
            (entry) => entry.initialization === "uninitialized",
          );
          const nextDevices = mergeDiscoveredDevices(
            [discoveredDevice, ...initialized],
            uninitialized,
          );
          updateDevices(nextDevices);
          setError(null);
          setState("results");
        },
      },
    );

    try {
      const [networkReport, usbReport] = await Promise.all([
        networkDiscovery,
        usbDiscovery,
      ]);
      if (operationGeneration.current !== generation) return;

      scanController.current = null;
      setScanInProgress(false);
      const usbSessionsById = new Map(
        usbReport.devices.map((session) => [session.info.device_id, session]),
      );
      const usbSessions = [...usbSessionsById.values()];
      setUsbIssue(
        usbReport.errors.length > 0 ? usbReport.errors.join(" · ") : null,
      );
      const initialized = networkReport.devices.filter(
        (entry): entry is InitializedDevice =>
          entry.initialization === "initialized",
      );
      const initializedIds = new Set(initialized.map((entry) => entry.deviceId));
      usbSessions.forEach((session) => {
        if (initializedIds.has(session.info.device_id)) {
          void closeOvisUsbDevice(session).catch(() => undefined);
        }
      });
      const combinedDevices = mergeDiscoveredDevices(
        initialized,
        usbSessions.map(toUninitializedDevice),
      );
      const report: DiscoveryReport = {
        ...networkReport,
        devices: combinedDevices,
      };
      setDiscoveryReport(report);
      updateDevices(combinedDevices);
      const reportError =
        combinedDevices.length > 0 ? null : reportErrorCode(report);
      if (reportError && !shouldRequestUsbDevice) {
        setError(reportError);
        setState("error");
      } else {
        setState("results");
      }

      void requestedUsbDevice.then(async (requested) => {
        if (operationGeneration.current !== generation) {
          if (requested.session) {
            await closeOvisUsbDevice(requested.session).catch(() => undefined);
          }
          return;
        }

        setUsbAuthorizationPending(false);
        if (requested.error) {
          setUsbIssue((currentIssue) =>
            currentIssue ? `${currentIssue} · ${requested.error}` : requested.error,
          );
        }

        if (!requested.session) {
          if (devicesRef.current.length === 0 && reportError) {
            setError(reportError);
            setState("error");
          }
          return;
        }

        manualUsbFallbackRef.current = true;
        const existing = devicesRef.current.find(
          (entry) => entry.deviceId === requested.session?.info.device_id,
        );
        if (existing?.initialization === "initialized") {
          await closeOvisUsbDevice(requested.session).catch(() => undefined);
          return;
        }
        if (
          existing?.initialization === "uninitialized" &&
          existing.usbSession.device !== requested.session.device
        ) {
          await closeOvisUsbDevice(existing.usbSession).catch(() => undefined);
        }

        const initializedDevices = devicesRef.current.filter(
          (entry): entry is InitializedDevice =>
            entry.initialization === "initialized",
        );
        const uninitializedDevices = devicesRef.current.filter(
          (entry) =>
            entry.initialization === "uninitialized" &&
            entry.deviceId !== requested.session?.info.device_id,
        );
        const nextDevices = mergeDiscoveredDevices(initializedDevices, [
          ...uninitializedDevices,
          toUninitializedDevice(requested.session),
        ]);
        updateDevices(nextDevices);
        setDiscoveryReport((currentReport) =>
          currentReport ? { ...currentReport, devices: nextDevices } : currentReport,
        );
        setError(null);
        setState("results");
      });
    } catch {
      void usbDiscovery.then((usbReport) =>
        Promise.allSettled(usbReport.devices.map(closeOvisUsbDevice)),
      );
      void requestedUsbDevice.then(async (requested) => {
        if (requested.session) {
          await closeOvisUsbDevice(requested.session).catch(() => undefined);
        }
      });
      if (
        operationGeneration.current !== generation ||
        controller.signal.aborted
      ) {
        return;
      }
      scanController.current = null;
      setScanInProgress(false);
      setUsbAuthorizationPending(false);
      setError("SCAN_NETWORK_ERROR");
      setState("error");
    }
  }, [updateDevices]);

  const cancelScan = useCallback(() => {
    if (applicationLockedRef.current) return;
    scanController.current?.abort();
    scanController.current = null;
    setScanInProgress(false);
    operationGeneration.current += 1;
    setUsbAuthorizationPending(false);
    setState(devicesRef.current.length > 0 ? "results" : "idle");
    setError(null);
  }, []);

  const selectDevice = useCallback((deviceId: string) => {
    if (applicationLockedRef.current) return;
    setSelectedDeviceId(deviceId);
    setError(null);
    setConnectionFailure((current) =>
      current?.deviceId === deviceId ? current : null,
    );
  }, []);

  const connect = useCallback(async () => {
    if (applicationLockedRef.current) return;
    const target = devicesRef.current.find(
      (entry) => entry.deviceId === selectedDeviceId,
    );
    if (!target) return;

    if (target.initialization === "uninitialized") {
      scanController.current?.abort();
      scanController.current = null;
      setScanInProgress(false);
      setUsbAuthorizationPending(false);
      operationGeneration.current += 1;
      setDevice(null);
      setConnectedAt(null);
      setError(null);
      setState("initializing");
      return;
    }

    scanController.current?.abort();
    scanController.current = null;
    setScanInProgress(false);
    setUsbAuthorizationPending(false);
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setState("connecting");
    setDevice(null);
    setConnectedAt(null);
    setError(null);
    setConnectionFailure(null);

    connectController.current?.abort();
    const controller = new AbortController();
    connectController.current = controller;

    try {
      const info = await fetchDeviceInfo(target.apiBaseUrl, {
        signal: controller.signal,
      });
      if (operationGeneration.current !== generation) return;
      if (info.device_id !== target.info.device_id) {
        throw new DeviceConnectionError("DEVICE_CHANGED");
      }

      const updatedDevices = devicesRef.current.map((entry) =>
        entry.initialization === "initialized" &&
        entry.deviceId === target.deviceId
          ? { ...entry, info, status: "online" as const }
          : entry,
      );
      updateDevices(updatedDevices);
      connectedTarget.current = {
        apiBaseUrl: target.apiBaseUrl,
        deviceId: target.deviceId,
      };
      lastSuccessfulAddress.current = target.apiBaseUrl;
      writeLastSuccessfulAddress(target.apiBaseUrl);
      rememberConnectedAddress(target.deviceId, target.apiBaseUrl);
      setDevice(info);
      setConnectedAt(new Date());
      setConnectionFailure(null);
      setState("connected");
    } catch (requestError) {
      if (operationGeneration.current !== generation) return;
      const code =
        requestError instanceof DeviceConnectionError
          ? requestError.code
          : "NETWORK_ERROR";
      const normalizedCode =
        code === "PERMISSION_DENIED"
          ? "LOCAL_NETWORK_PERMISSION_DENIED"
          : code;
      updateDevices(
        devicesRef.current.map((entry) =>
          entry.initialization === "initialized" &&
          entry.deviceId === target.deviceId
            ? { ...entry, status: "offline" as const }
            : entry,
        ),
      );
      setConnectionFailure({
        deviceId: target.deviceId,
        apiBaseUrl: target.apiBaseUrl,
        code: normalizedCode,
      });
      setError(null);
      setState("results");
    } finally {
      if (connectController.current === controller) {
        connectController.current = null;
      }
    }
  }, [selectedDeviceId, updateDevices]);

  const connectManualAddress = useCallback(
    async (ipAddress: string) => {
      if (applicationLockedRef.current) return;
      const apiBaseUrl = buildDeviceApiBaseUrl(ipAddress);
      if (!apiBaseUrl) {
        setError("INVALID_RESPONSE");
        setState("error");
        return;
      }

      scanController.current?.abort();
      scanController.current = null;
      setScanInProgress(false);
      connectController.current?.abort();
      const controller = new AbortController();
      connectController.current = controller;
      const generation = operationGeneration.current + 1;
      operationGeneration.current = generation;
      setSelectedDeviceId(null);
      setDevice(null);
      setConnectedAt(null);
      setError(null);
      setConnectionFailure(null);
      setState("connecting");

      try {
        const info = await fetchDeviceInfo(apiBaseUrl, {
          signal: controller.signal,
        });
        if (operationGeneration.current !== generation) return;
        const manualDevice: InitializedDevice = {
          initialization: "initialized",
          source: "network",
          deviceId: info.device_id,
          ipAddress: new URL(apiBaseUrl).hostname,
          apiBaseUrl,
          info,
          status: "online",
        };
        updateDevices([
          manualDevice,
          ...devicesRef.current.filter(
            (entry) => entry.deviceId !== info.device_id,
          ),
        ]);
        setSelectedDeviceId(info.device_id);
        connectedTarget.current = { apiBaseUrl, deviceId: info.device_id };
        lastSuccessfulAddress.current = apiBaseUrl;
        writeLastSuccessfulAddress(apiBaseUrl);
        rememberConnectedAddress(info.device_id, apiBaseUrl);
        setDevice(info);
        setConnectedAt(new Date());
        setConnectionFailure(null);
        setState("connected");
      } catch (requestError) {
        if (operationGeneration.current !== generation) return;
        const code =
          requestError instanceof DeviceConnectionError
            ? requestError.code
            : "NETWORK_ERROR";
        setError(
          code === "PERMISSION_DENIED"
            ? "LOCAL_NETWORK_PERMISSION_DENIED"
            : code,
        );
        setState("error");
      } finally {
        if (connectController.current === controller) {
          connectController.current = null;
        }
      }
    },
    [updateDevices],
  );

  const disconnect = useCallback(() => {
    if (applicationLockedRef.current) return;
    operationGeneration.current += 1;
    connectController.current?.abort();
    connectController.current = null;
    connectedTarget.current = null;
    setState(devicesRef.current.length > 0 ? "results" : "idle");
    setDevice(null);
    setError(null);
    setConnectedAt(null);
    setConnectionFailure(null);
  }, []);

  const resetNetwork = useCallback(async () => {
    if (applicationLockedRef.current) return;
    const target = connectedTarget.current;
    if (!target) throw new DeviceConnectionError("DEVICE_NOT_FOUND");

    await resetDeviceNetwork(target.apiBaseUrl);
    operationGeneration.current += 1;
    forgetOvisSubnet(target.deviceId);
    if (lastSuccessfulAddress.current === target.apiBaseUrl) {
      lastSuccessfulAddress.current = null;
      clearLastSuccessfulAddress();
    }
    connectedTarget.current = null;

    const remaining = devicesRef.current.filter(
      (entry) => entry.deviceId !== target.deviceId,
    );
    updateDevices(remaining);
    setSelectedDeviceId(null);
    setDevice(null);
    setError(null);
    setConnectedAt(null);
    setState(remaining.length > 0 ? "results" : "idle");
  }, [updateDevices]);

  const cancelInitialization = useCallback(() => {
    operationGeneration.current += 1;
    setState(devicesRef.current.length > 0 ? "results" : "idle");
    setError(null);
  }, []);

  const removeUninitializedDevice = useCallback(
    (deviceId: string) => {
      const remaining = devicesRef.current.filter(
        (entry) =>
          entry.initialization === "initialized" || entry.deviceId !== deviceId,
      );
      updateDevices(remaining);
      if (selectedDeviceId === deviceId) setSelectedDeviceId(null);
      setState(remaining.length > 0 ? "results" : "idle");
    },
    [selectedDeviceId, updateDevices],
  );

  const rescan = useCallback(async () => {
    if (applicationLockedRef.current) return;
    await scan();
  }, [scan]);

  const retry = useCallback(async () => {
    if (applicationLockedRef.current) return;
    if (selectedDeviceId) {
      await connect();
      return;
    }
    await scan();
  }, [connect, scan, selectedDeviceId]);

  useEffect(() => {
    if (
      state !== "connected" ||
      !connectedTarget.current ||
      applicationLocked
    ) {
      return;
    }

    const generation = operationGeneration.current;
    const target = connectedTarget.current;
    let failures = 0;
    let heartbeatRunning = false;
    let active = true;

    const heartbeat = window.setInterval(async () => {
      if (!active || applicationLockedRef.current || heartbeatRunning) return;
      heartbeatRunning = true;

      try {
        const info = await fetchDeviceInfo(target.apiBaseUrl);
        if (!active || applicationLockedRef.current || operationGeneration.current !== generation) return;
        if (info.device_id !== target.deviceId) {
          throw new DeviceConnectionError("DEVICE_CHANGED");
        }
        failures = 0;
        setDevice(info);
      } catch {
        if (!active || applicationLockedRef.current || operationGeneration.current !== generation) return;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          window.clearInterval(heartbeat);
          connectedTarget.current = null;
          updateDevices(
            devicesRef.current.map((entry) =>
              entry.initialization === "initialized" &&
              entry.deviceId === target.deviceId
                ? { ...entry, status: "offline" as const }
                : entry,
            ),
          );
          setDevice(null);
          setConnectedAt(null);
          setState("error");
          setError("DEVICE_DISCONNECTED");
        }
      } finally {
        heartbeatRunning = false;
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(heartbeat);
    };
  }, [applicationLocked, state, updateDevices]);

  useEffect(() => {
    if (!isWebUsbAvailable()) return;
    return onWebUsbDeviceChange(() => {
      if (state === "initializing") return;
      void getAuthorizedOvisUsbDevices()
        .then((sessions) => {
          const initialized = devicesRef.current.filter(
            (entry): entry is InitializedDevice =>
              entry.initialization === "initialized",
          );
          const combined = mergeDiscoveredDevices(
            initialized,
            sessions.map(toUninitializedDevice),
          );
          updateDevices(combined);
          if (combined.length > 0 && (state === "idle" || state === "error")) {
            setError(null);
            setState("results");
          }
          if (
            selectedDeviceId &&
            !combined.some((entry) => entry.deviceId === selectedDeviceId)
          ) {
            setSelectedDeviceId(null);
          }
        })
        .catch(() => undefined);
    });
  }, [selectedDeviceId, state, updateDevices]);

  useEffect(
    () => () => {
      scanController.current?.abort();
      connectController.current?.abort();
      operationGeneration.current += 1;
    },
    [],
  );

  return {
    state,
    devices,
    selectedDevice,
    initializedDevices,
    device,
    error,
    connectedAt,
    applicationLocked,
    usbAvailable: isWebUsbAvailable(),
    usbPreflightReady,
    usbAuthorizationPending,
    usbIssue,
    discoveryReport,
    scanInProgress,
    connectionFailure,
    scan,
    cancelScan,
    selectDevice,
    connect,
    connectManualAddress,
    disconnect,
    resetNetwork,
    rescan,
    retry,
    cancelInitialization,
    removeUninitializedDevice,
    setApplicationLocked,
    adoptRecoveredDevice,
  };
}
