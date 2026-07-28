import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  localizedImporterName,
  localizedModelStatus,
  localizedModelTask,
  localizedRuntimeText,
  localizedTaskMessage,
} from "../../i18n.runtime";
import {
  Activity,
  ArrowLeft,
  Box,
  CheckCircle2,
  Cpu,
  FileUp,
  Image,
  LoaderCircle,
  Mic2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  ScanSearch,
  Shapes,
  Trash2,
  X,
} from "lucide-react";
import {
  ModelApiError,
  activateModel,
  cancelModelImport,
  commitModelImport,
  createModelImport,
  deactivateModel,
  deleteModel,
  getModel,
  getModelDeployment,
  getModelImport,
  getModelImporters,
  getModelTask,
  listModels,
  updateModelDeployment,
  uploadModelContent,
} from "./model.api";
import { SUPPORTED_IMPORTERS, supportedImporter } from "./model.importers";
import { reconnectDeviceByIdentity } from "../config/config.recovery";
import type { OvisDeviceInfo } from "../device/device.types";
import {
  clearPendingModelTask,
  readPendingModelTask,
  writePendingModelTask,
} from "./model.session";
import type { PendingModelTask } from "./model.session";
import type {
  DeploymentParameters,
  DeploymentState,
  ImportFormSubmission,
  ImportTask,
  ImporterCatalog,
  ModelDetail,
  ModelImporter,
  ModelList,
  ModelSizeConstraints,
  ModelSummary,
  ModelTask,
  ModelTaskType,
  ModelWorkspaceView,
  RuntimeJsonSchema,
  UploadHandle,
  UploadProgress,
} from "./model.types";

const TASK_POLL_INTERVAL_MS = 1_500;
const IMPORT_STORAGE_PREFIX = "ovis_model_import_ids:";
const MODEL_OUTCOME_STORAGE_PREFIX = "ovis_model_outcome:";

type ModelOperationState = "idle" | "applying" | "reconnecting" | "failed";

interface ModelManagerProps {
  apiBaseUrl: string;
  deviceId: string;
  disabled?: boolean;
  refreshToken?: number;
  activeDetectionModelId?: string | null;
  customDetectionActive?: boolean;
  hasUnsavedConfig?: boolean;
  onModelsChange?: (models: ModelSummary[]) => void;
  onDeploymentComplete?: (apiBaseUrl: string) => void | Promise<void>;
  onBeforeActivate?: () => boolean;
  onApplicationLockChange?: (locked: boolean) => void;
  onDeviceRecovered?: (apiBaseUrl: string, info: OvisDeviceInfo) => void;
}

const delay = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const abort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });

const importStorageKey = (deviceId: string) => `${IMPORT_STORAGE_PREFIX}${deviceId}`;
const modelOutcomeStorageKey = (deviceId: string) =>
  `${MODEL_OUTCOME_STORAGE_PREFIX}${deviceId}`;

const readImportIds = (deviceId: string): string[] => {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(importStorageKey(deviceId)) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
};

const writeImportIds = (deviceId: string, ids: string[]) => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    window.localStorage.removeItem(importStorageKey(deviceId));
  } else {
    window.localStorage.setItem(importStorageKey(deviceId), JSON.stringify(unique));
  }
};

const rememberImport = (deviceId: string, importId: string) =>
  writeImportIds(deviceId, [...readImportIds(deviceId), importId]);

const forgetImport = (deviceId: string, importId: string) =>
  writeImportIds(
    deviceId,
    readImportIds(deviceId).filter((id) => id !== importId),
  );

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const formatDate = (seconds: number, locale?: string) =>
  new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));

const deploymentDraftFromState = (
  state: DeploymentState,
): DeploymentParameters => {
  const draft = structuredClone(state.parameters);
  if (!draft.processingSize) {
    const schema = state.parameterSchema as Record<string, RuntimeJsonSchema>;
    const constraints =
      state.processingSizeConstraints ?? schema.processingSize?.constraints;
    const initial = constraints?.presets?.[0];
    if (initial) draft.processingSize = { ...initial };
  }
  return draft;
};

const normalizeModelSizeConstraints = (
  value: ModelSizeConstraints | undefined,
): Required<ModelSizeConstraints> | null => {
  const widthStep = value?.widthStep ?? value?.step;
  const heightStep = value?.heightStep ?? value?.step;
  if (
    !value ||
    !Number.isFinite(value.minWidth) ||
    !Number.isFinite(value.maxWidth) ||
    !Number.isFinite(value.minHeight) ||
    !Number.isFinite(value.maxHeight) ||
    !Number.isFinite(widthStep) ||
    !Number.isFinite(heightStep) ||
    (widthStep ?? 0) <= 0 ||
    (heightStep ?? 0) <= 0
  ) {
    return null;
  }
  const recommended = [
    { width: 448, height: 256 },
    { width: 512, height: 288 },
    { width: 640, height: 360 },
    { width: 640, height: 384 },
  ];
  const presets = [...(value.presets ?? []), ...recommended].filter(
    (preset, index, all) =>
      preset.width >= value.minWidth! &&
      preset.width <= value.maxWidth! &&
      preset.height >= value.minHeight! &&
      preset.height <= value.maxHeight! &&
      (preset.width - value.minWidth!) % widthStep! === 0 &&
      (preset.height - value.minHeight!) % heightStep! === 0 &&
      all.findIndex(
        (entry) => entry.width === preset.width && entry.height === preset.height,
      ) === index,
  );
  return {
    minWidth: value.minWidth!,
    maxWidth: value.maxWidth!,
    minHeight: value.minHeight!,
    maxHeight: value.maxHeight!,
    widthStep: widthStep!,
    heightStep: heightStep!,
    step: value.step ?? widthStep!,
    presets,
  };
};

const taskIcon = (task: ModelTaskType) => {
  if (task === "object_detection") return <ScanSearch size={18} />;
  if (task === "image_classification") return <Image size={18} />;
  if (task === "keypoint_detection") return <Activity size={18} />;
  if (task === "instance_segmentation") return <Shapes size={18} />;
  if (task === "image_feature") return <Cpu size={18} />;
  return <Mic2 size={18} />;
};

const taskTypes: ModelTaskType[] = [
  "object_detection",
  "image_classification",
  "keypoint_detection",
  "instance_segmentation",
  "image_feature",
  "sound_classification",
];

export function ModelManager({
  apiBaseUrl,
  deviceId,
  disabled = false,
  refreshToken = 0,
  activeDetectionModelId = null,
  customDetectionActive = false,
  hasUnsavedConfig = false,
  onModelsChange,
  onDeploymentComplete,
  onBeforeActivate,
  onApplicationLockChange,
  onDeviceRecovered,
}: ModelManagerProps) {
  const { t, i18n } = useTranslation();
  const [catalog, setCatalog] = useState<ImporterCatalog | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [pendingImports, setPendingImports] = useState<ImportTask[]>([]);
  const [view, setView] = useState<ModelWorkspaceView>({ type: "list" });
  const [activeImport, setActiveImport] = useState<ImportTask | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [selectedRetryFile, setSelectedRetryFile] = useState<File | null>(null);
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [deployment, setDeployment] = useState<DeploymentState | null>(null);
  const [deploymentDraft, setDeploymentDraft] = useState<DeploymentParameters | null>(null);
  const [configTask, setConfigTask] = useState<ModelTask | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ModelSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [operationState, setOperationState] =
    useState<ModelOperationState>("idle");
  const [operationModelId, setOperationModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(() =>
    window.sessionStorage.getItem(modelOutcomeStorageKey(deviceId)),
  );
  const uploadHandle = useRef<UploadHandle | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const activeApiBaseUrl = useRef(apiBaseUrl);

  useEffect(() => {
    activeApiBaseUrl.current = apiBaseUrl;
  }, [apiBaseUrl]);

  const importers = useMemo(
    () =>
      (catalog?.importers ?? []).filter(
        (importer): importer is ModelImporter => Boolean(supportedImporter(importer)),
      ),
    [catalog],
  );

  const importerById = useCallback(
    (id: string) => importers.find((importer) => importer.id === id) ?? null,
    [importers],
  );

  const isDeployable = useCallback(
    (model: ModelDetail | ModelSummary) => {
      const importer = importerById(model.importerId);
      return (
        model.deployable &&
        importer?.deployable === true &&
        importer.runtimeConsumers.length > 0
      );
    },
    [importerById],
  );

  useEffect(() => {
    const controller = new AbortController();
    void getModelImporters(apiBaseUrl, controller.signal)
      .then(setCatalog)
      .catch((nextError) => {
        if (!(nextError instanceof DOMException && nextError.name === "AbortError")) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      });
    return () => controller.abort();
  }, [apiBaseUrl, catalogReload]);

  useEffect(
    () => () => {
      operationController.current?.abort();
      uploadHandle.current?.cancel();
    },
    [],
  );

  const recoverImports = useCallback(
    async () => {
      const ids = readImportIds(deviceId);
      const recovered: ImportTask[] = [];
      await Promise.all(
        ids.map(async (id) => {
          try {
            recovered.push(await getModelImport(apiBaseUrl, id));
          } catch (nextError) {
            if (!(nextError instanceof ModelApiError) || nextError.status !== 404) {
              return;
            }
            try {
              await getModel(apiBaseUrl, id);
              forgetImport(deviceId, id);
            } catch {
              // Keep unknown IDs so a temporary manager outage does not lose recovery state.
            }
          }
        }),
      );
      recovered.sort((left, right) => right.createdAt - left.createdAt);
      setPendingImports(recovered);
      if (view.type === "import-task") {
        setActiveImport(recovered.find((task) => task.id === view.importId) ?? null);
      }
    },
    [apiBaseUrl, deviceId, view],
  );

  const refreshModels = useCallback(
    async () => {
      const nextList = await listModels(activeApiBaseUrl.current);
      setModelList(nextList);
      onModelsChange?.(nextList.models);
      return nextList;
    },
    [onModelsChange],
  );

  useEffect(() => {
    let active = true;
    void Promise.all([refreshModels(), recoverImports()]).catch((nextError) => {
      if (active) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    });
    return () => {
      active = false;
    };
  }, [recoverImports, refreshModels, refreshToken]);

  const commitImport = useCallback(
    async (task: ImportTask) => {
      setBusy(true);
      setError(null);
      try {
        let model: ModelDetail;
        try {
          model = await commitModelImport(apiBaseUrl, task.id);
        } catch (commitError) {
          if (
            !(commitError instanceof ModelApiError) ||
            commitError.status === undefined ||
            commitError.status === 404
          ) {
            model = await getModel(apiBaseUrl, task.id);
          } else {
            const refreshed = await getModelImport(apiBaseUrl, task.id);
            setActiveImport(refreshed);
            setPendingImports((current) =>
              current.map((entry) => (entry.id === refreshed.id ? refreshed : entry)),
            );
            throw new ModelApiError(
              refreshed.validationError ?? refreshed.error ?? commitError.message,
              commitError.status,
            );
          }
        }
        forgetImport(deviceId, task.id);
        setPendingImports((current) => current.filter((entry) => entry.id !== task.id));
        setActiveImport(null);
        setDetail(model);
        setView({ type: "detail", modelId: model.id });
        await refreshModels();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setBusy(false);
      }
    },
    [apiBaseUrl, deviceId, refreshModels],
  );

  const uploadImport = useCallback(
    async (task: ImportTask, file: File) => {
      if (file.size !== task.fileSize) {
        setError(t("models.fileSizeMismatch"));
        return;
      }
      setBusy(true);
      setError(null);
      setUploadProgress({ loaded: 0, total: file.size, percent: 0 });
      const handle = uploadModelContent(
        apiBaseUrl,
        task.id,
        file,
        setUploadProgress,
      );
      uploadHandle.current = handle;
      try {
        const uploaded = await handle.promise;
        setActiveImport(uploaded);
        setPendingImports((current) => [
          uploaded,
          ...current.filter((entry) => entry.id !== uploaded.id),
        ]);
        setUploadProgress({ loaded: file.size, total: file.size, percent: 100 });
        await commitImport(uploaded);
      } catch (nextError) {
        if (nextError instanceof DOMException && nextError.name === "AbortError") {
          setError(t("models.uploadCancelled"));
        } else {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
        try {
          const refreshed = await getModelImport(apiBaseUrl, task.id);
          setActiveImport(refreshed);
          setPendingImports((current) => [
            refreshed,
            ...current.filter((entry) => entry.id !== refreshed.id),
          ]);
        } catch {
          // The original error remains the useful diagnostic.
        }
      } finally {
        uploadHandle.current = null;
        setBusy(false);
      }
    },
    [apiBaseUrl, commitImport, t],
  );

  const startImport = async (submission: ImportFormSubmission) => {
    setBusy(true);
    setError(null);
    try {
      const task = await createModelImport(apiBaseUrl, {
        importerId: submission.importer.id,
        schemaVersion: submission.importer.schemaVersion,
        name: submission.name,
        fileSize: submission.file.size,
        metadata: submission.metadata,
      });
      rememberImport(deviceId, task.id);
      setActiveImport(task);
      setPendingImports((current) => [task, ...current]);
      setView({ type: "import-task", importId: task.id });
      await uploadImport(task, submission.file);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setBusy(false);
    }
  };

  const openImportTask = (task: ImportTask) => {
    setActiveImport(task);
    setSelectedRetryFile(null);
    setUploadProgress(null);
    setError(null);
    setView({ type: "import-task", importId: task.id });
  };

  const cancelImport = async () => {
    if (!activeImport) return;
    uploadHandle.current?.cancel();
    setBusy(true);
    try {
      await cancelModelImport(apiBaseUrl, activeImport.id);
      forgetImport(deviceId, activeImport.id);
      setPendingImports((current) => current.filter((entry) => entry.id !== activeImport.id));
      setActiveImport(null);
      setView({ type: "list" });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (modelId: string) => {
    setBusy(true);
    setError(null);
    try {
      const model = await getModel(apiBaseUrl, modelId);
      setDetail(model);
      setView({ type: "detail", modelId });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const openDeployment = async (modelId: string) => {
    setBusy(true);
    setError(null);
    try {
      const [model, nextDeployment] = await Promise.all([
        getModel(apiBaseUrl, modelId),
        getModelDeployment(apiBaseUrl, modelId),
      ]);
      setDetail(model);
      setDeployment(nextDeployment);
      setDeploymentDraft(deploymentDraftFromState(nextDeployment));
      setView({ type: "deployment", modelId });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const saveDeploymentParameters = async () => {
    if (!detail || !deployment || !deploymentDraft) return;
    if (hasUnsavedConfig) {
      setError(t("models.unsavedConfigConflict"));
      return;
    }
    const parameterSchema = deployment.parameterSchema as Record<
      string,
      RuntimeJsonSchema
    >;
    const thresholdSchema = parameterSchema.threshold ?? {};
    const sizeSchema = parameterSchema.processingSize ?? {};
    const sizeConstraints = normalizeModelSizeConstraints(
      deployment.processingSizeConstraints ??
        sizeSchema.constraints ?? {
          minWidth: sizeSchema.minWidth,
          maxWidth: sizeSchema.maxWidth,
          minHeight: sizeSchema.minHeight,
          maxHeight: sizeSchema.maxHeight,
          step: sizeSchema.step,
        },
    );
    const size = deploymentDraft.processingSize;
    const thresholdValid =
      Number.isFinite(deploymentDraft.threshold) &&
      deploymentDraft.threshold >= (thresholdSchema.minimum ?? 0) &&
      deploymentDraft.threshold <= (thresholdSchema.maximum ?? 1);
    const sizeValid =
      !sizeConstraints ||
      (size !== undefined &&
        Number.isInteger(size.width) &&
        Number.isInteger(size.height) &&
        size.width >= sizeConstraints.minWidth &&
        size.width <= sizeConstraints.maxWidth &&
        size.height >= sizeConstraints.minHeight &&
        size.height <= sizeConstraints.maxHeight &&
        (size.width - sizeConstraints.minWidth) % sizeConstraints.widthStep === 0 &&
        (size.height - sizeConstraints.minHeight) % sizeConstraints.heightStep === 0);
    if (!thresholdValid || !sizeValid) {
      setError(t("models.invalidDeploymentParameters"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await updateModelDeployment(
        activeApiBaseUrl.current,
        detail.id,
        deploymentDraft,
      );
      setDeployment(saved);
      setDeploymentDraft(deploymentDraftFromState(saved));
      return saved;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const inferTaskResult = useCallback(
    async (requestApiBaseUrl: string, modelId: string, desiredActive: boolean) => {
      const [model, nextDeployment] = await Promise.all([
        getModel(requestApiBaseUrl, modelId),
        getModelDeployment(requestApiBaseUrl, modelId),
      ]);
      setDetail(model);
      setDeployment(nextDeployment);
      setDeploymentDraft(deploymentDraftFromState(nextDeployment));
      if (!desiredActive) {
        return (
          model.active === false &&
          model.referenced === false &&
          nextDeployment.active === false &&
          nextDeployment.referenced === false &&
          nextDeployment.appliedParameters === null
        );
      }
      return (
        model.active === true &&
        model.referenced === true &&
        nextDeployment.active === true &&
        nextDeployment.referenced === true &&
        JSON.stringify(nextDeployment.appliedParameters) ===
          JSON.stringify(nextDeployment.parameters)
      );
    },
    [],
  );

  const recoverTaskDevice = useCallback(
    async (pending: PendingModelTask, controller: AbortController) => {
      setOperationState("reconnecting");
      const recovered = await reconnectDeviceByIdentity(pending, controller.signal);
      activeApiBaseUrl.current = recovered.apiBaseUrl;
      const nextPending = { ...pending, api_base_url: recovered.apiBaseUrl };
      writePendingModelTask(nextPending);
      onDeviceRecovered?.(recovered.apiBaseUrl, recovered.info);
      setOperationState("applying");
      return nextPending;
    },
    [onDeviceRecovered],
  );

  const pollDeploymentTask = useCallback(
    async (
      pending: PendingModelTask,
      controller: AbortController,
    ) => {
      let activePending = pending;
      const deadline = pending.started_at + 90_000;
      while (!controller.signal.aborted && Date.now() < deadline) {
        const requestApiBaseUrl = activePending.api_base_url;
        try {
          const task = await getModelTask(
            requestApiBaseUrl,
            activePending.task_id,
            controller.signal,
          );
          setConfigTask(task);
          if (task.state === "failed") {
            window.sessionStorage.setItem(
              modelOutcomeStorageKey(deviceId),
              task.message,
            );
            activeApiBaseUrl.current = requestApiBaseUrl;
            await refreshModels();
            const [model, nextDeployment] = await Promise.all([
              getModel(requestApiBaseUrl, activePending.model_id),
              getModelDeployment(requestApiBaseUrl, activePending.model_id),
            ]);
            setDetail(model);
            setDeployment(nextDeployment);
            setDeploymentDraft(deploymentDraftFromState(nextDeployment));
            await onDeploymentComplete?.(requestApiBaseUrl);
            clearPendingModelTask();
            throw new ModelApiError(task.message, 409);
          }
          if (task.state === "succeeded") {
            if (
              await inferTaskResult(
                requestApiBaseUrl,
                activePending.model_id,
                activePending.desired_active,
              )
            ) {
              break;
            }
          }
        } catch (nextError) {
          if (nextError instanceof ModelApiError && nextError.status === 404) {
            try {
              if (
                await inferTaskResult(
                  requestApiBaseUrl,
                  activePending.model_id,
                  activePending.desired_active,
                )
              ) {
                break;
              }
            } catch (verificationError) {
              if (
                verificationError instanceof ModelApiError &&
                verificationError.status !== undefined
              ) {
                throw verificationError;
              }
              activePending = await recoverTaskDevice(activePending, controller);
            }
          } else if (
            nextError instanceof ModelApiError &&
            nextError.status === undefined
          ) {
            activePending = await recoverTaskDevice(activePending, controller);
          } else {
            throw nextError;
          }
        }
        await delay(TASK_POLL_INTERVAL_MS, controller.signal);
      }
      if (controller.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (Date.now() >= deadline) {
        clearPendingModelTask();
        throw new ModelApiError(t("models.reconnectTimeout"));
      }
      clearPendingModelTask();
      window.sessionStorage.removeItem(modelOutcomeStorageKey(deviceId));
      activeApiBaseUrl.current = activePending.api_base_url;
      await refreshModels();
      await onDeploymentComplete?.(activePending.api_base_url);
    },
    [
      deviceId,
      inferTaskResult,
      onDeploymentComplete,
      recoverTaskDevice,
      refreshModels,
      t,
    ],
  );

  useEffect(() => {
    const pending = readPendingModelTask();
    if (!pending || pending.device_id !== deviceId) return;
    const controller = new AbortController();
    operationController.current?.abort();
    operationController.current = controller;
    const activePending = {
      ...pending,
      api_base_url: activeApiBaseUrl.current,
    };
    setBusy(true);
    setOperationState("applying");
    setOperationModelId(activePending.model_id);
    setError(null);
    onApplicationLockChange?.(true);
    writePendingModelTask(activePending);
    setView({ type: "deployment", modelId: activePending.model_id });
    void pollDeploymentTask(activePending, controller)
      .then(() => setOperationState("idle"))
      .catch((nextError) => {
        if (!(nextError instanceof DOMException && nextError.name === "AbortError")) {
          clearPendingModelTask();
          setError(nextError instanceof Error ? nextError.message : String(nextError));
          setOperationState("failed");
        }
      })
      .finally(() => {
        if (operationController.current === controller) {
          setBusy(false);
          if (!readPendingModelTask()) onApplicationLockChange?.(false);
        }
      });
    return () => controller.abort();
  }, [deviceId, onApplicationLockChange, pollDeploymentTask]);

  const runDeploymentTask = async (
    desiredActive: boolean,
    modelId = detail?.id,
  ) => {
    if (!modelId) return;
    if (hasUnsavedConfig) {
      setError(t("models.unsavedConfigConflict"));
      return;
    }
    if (desiredActive && onBeforeActivate && !onBeforeActivate()) return;
    const controller = new AbortController();
    operationController.current?.abort();
    operationController.current = controller;
    setBusy(true);
    setOperationState("applying");
    setOperationModelId(modelId);
    setError(null);
    setConfigTask(null);
    onApplicationLockChange?.(true);
    const startedAt = Date.now();
    const requestApiBaseUrl = activeApiBaseUrl.current;
    try {
      const accepted = desiredActive
        ? await activateModel(requestApiBaseUrl, modelId, controller.signal)
        : await deactivateModel(requestApiBaseUrl, modelId, controller.signal);
      const pending: PendingModelTask = {
        task_id: accepted.task_id,
        model_id: modelId,
        device_id: deviceId,
        api_base_url: requestApiBaseUrl,
        started_at: startedAt,
        desired_active: desiredActive,
      };
      writePendingModelTask(pending);
      await pollDeploymentTask(pending, controller);
      setOperationState("idle");
    } catch (nextError) {
      if (!(nextError instanceof DOMException && nextError.name === "AbortError")) {
        if (nextError instanceof ModelApiError && nextError.status === undefined) {
          try {
            setOperationState("reconnecting");
            const recovered = await reconnectDeviceByIdentity(
              {
                device_id: deviceId,
                api_base_url: requestApiBaseUrl,
                started_at: startedAt,
              },
              controller.signal,
            );
            activeApiBaseUrl.current = recovered.apiBaseUrl;
            onDeviceRecovered?.(recovered.apiBaseUrl, recovered.info);
            if (
              await inferTaskResult(
                recovered.apiBaseUrl,
                modelId,
                desiredActive,
              )
            ) {
              await refreshModels();
              await onDeploymentComplete?.(recovered.apiBaseUrl);
              setOperationState("idle");
              return;
            }
            throw new ModelApiError(t("models.taskOutcomeUnknown"));
          } catch (recoveryError) {
            setError(
              recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError),
            );
            setOperationState("failed");
          }
        } else {
          clearPendingModelTask();
          setError(nextError instanceof Error ? nextError.message : String(nextError));
          setOperationState("failed");
        }
      }
    } finally {
      if (operationController.current === controller) {
        setBusy(false);
        if (!readPendingModelTask()) onApplicationLockChange?.(false);
      }
    }
  };

  const saveDeployment = async () => {
    const shouldReapply =
      customDetectionActive && detail?.id === activeDetectionModelId;
    const saved = await saveDeploymentParameters();
    if (saved && shouldReapply) {
      await runDeploymentTask(true, saved.modelId);
    }
  };

  const confirmDelete = async () => {
    if (!deleteCandidate || deleteCandidate.referenced || deleteCandidate.active) return;
    setBusy(true);
    try {
      await deleteModel(apiBaseUrl, deleteCandidate.id);
      setDeleteCandidate(null);
      await refreshModels();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const selectedImporter =
    view.type === "import" ? importerById(view.importerId) : null;
  const importerDefinition = selectedImporter
    ? SUPPORTED_IMPORTERS.find((entry) => entry.id === selectedImporter.id)
    : null;
  const ImportForm = importerDefinition?.component;

  if (!catalog) {
    return (
      <div className="models-empty-state">
        {error ? <Box size={20} /> : <LoaderCircle className="button-spinner" size={20} />}
        <span>{error ?? t("models.loadingCapabilities")}</span>
        {error && (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => {
              setError(null);
              setCatalogReload((value) => value + 1);
            }}
          >
            <RefreshCw size={14} />
            {t("common.retry")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="model-manager" aria-busy={busy}>
      <header className="model-manager__toolbar">
        <div>
          {view.type !== "list" && (
            <button type="button" className="icon-button" title={t("common.back")} onClick={() => setView({ type: "list" })}><ArrowLeft size={15} /></button>
          )}
          <span><strong>{t(`models.views.${view.type}`)}</strong><small>{modelList ? t("models.modelCount", { count: modelList.models.length }) : t("models.loading")}</small></span>
        </div>
        <div>
          <button type="button" className="icon-button" title={t("common.refresh")} disabled={busy || disabled} onClick={() => void Promise.all([refreshModels(), recoverImports()])}><RefreshCw size={15} /></button>
          {view.type === "list" && <button type="button" className="button button--secondary" disabled={busy || disabled} onClick={() => setView({ type: "choose-task" })}><Plus size={14} />{t("models.addModel")}</button>}
        </div>
      </header>

      {error && <div className="model-error" role="alert"><span>{localizedRuntimeText(error, t("models.operationFailed"), i18n.language)}</span><button className="icon-button" type="button" onClick={() => { window.sessionStorage.removeItem(modelOutcomeStorageKey(deviceId)); setError(null); }}><X size={14} /></button></div>}
      {busy && (configTask || readPendingModelTask()) && (
        <div className="model-operation-status" role="status">
          <LoaderCircle className="button-spinner" size={15} />
          <span>
            <strong>
              {operationState === "reconnecting"
                ? t("models.reconnecting")
                : t("models.applying")}
            </strong>
            <small>
              {operationState === "reconnecting"
                ? t("models.reconnectingDetail")
                : configTask
                  ? localizedTaskMessage(configTask, i18n.language)
                  : t("models.waitingForTask")}
            </small>
          </span>
          <output>{configTask?.progress ?? 0}%</output>
        </div>
      )}

      {view.type === "list" && (
        <ModelListView
          models={modelList?.models ?? []}
          pendingImports={pendingImports}
          locale={i18n.language}
          isDeployable={isDeployable}
          disabled={busy || disabled}
          onImport={openImportTask}
          onDetail={(id) => void openDetail(id)}
          onDeployment={(id) => void openDeployment(id)}
          onActivate={(id) => void runDeploymentTask(true, id)}
          onDeactivate={(id) => void runDeploymentTask(false, id)}
          onDelete={setDeleteCandidate}
          activeDetectionModelId={activeDetectionModelId}
          customDetectionActive={customDetectionActive}
          operationState={operationState}
          pendingModelId={
            readPendingModelTask()?.model_id ?? operationModelId
          }
        />
      )}

      {view.type === "choose-task" && (
        <div className="model-choice-grid">
          {taskTypes.map((task) => {
            const available = importers.some((importer) => importer.task === task);
            if (!available) return null;
            return <button type="button" key={task} onClick={() => setView({ type: "choose-importer", task })}>{taskIcon(task)}<strong>{t(`models.tasks.${task}`)}</strong><span>{importers.filter((importer) => importer.task === task).length}</span></button>;
          })}
        </div>
      )}

      {view.type === "choose-importer" && (
        <div className="model-importer-list">
          {importers.filter((importer) => importer.task === view.task).map((importer) => (
            <button type="button" key={importer.id} onClick={() => setView({ type: "import", importerId: importer.id })}><span><strong>{localizedImporterName(importer.id, importer.name, i18n.language)}</strong><small>{importer.id}</small></span><output>{formatBytes(importer.maxFileSize)}</output></button>
          ))}
        </div>
      )}

      {view.type === "import" && selectedImporter && ImportForm && (
        <ImportForm importer={selectedImporter} availableBytes={Math.min(catalog.availableBytes, selectedImporter.maxFileSize)} disabled={busy || disabled} onSubmit={(submission) => void startImport(submission)} onCancel={() => setView({ type: "choose-importer", task: selectedImporter.task })} />
      )}

      {view.type === "import-task" && activeImport && (
        <ImportTaskView task={activeImport} progress={uploadProgress} file={selectedRetryFile} busy={busy} onFile={setSelectedRetryFile} onRetry={() => { if (selectedRetryFile) void uploadImport(activeImport, selectedRetryFile); }} onCommit={() => void commitImport(activeImport)} onCancel={() => void cancelImport()} onCancelUpload={() => uploadHandle.current?.cancel()} />
      )}

      {view.type === "detail" && detail && (
        <ModelDetailView model={detail} importer={importerById(detail.importerId)} locale={i18n.language} deployable={isDeployable(detail)} runtimeActive={customDetectionActive && activeDetectionModelId === detail.id} onDeployment={() => void openDeployment(detail.id)} onDeactivate={() => void runDeploymentTask(false)} onDelete={() => setDeleteCandidate(modelList?.models.find((entry) => entry.id === detail.id) ?? null)} busy={busy || disabled} />
      )}

      {view.type === "deployment" && detail && deployment && deploymentDraft && (
        <ModelDeploymentView model={detail} importer={importerById(detail.importerId)} deployment={deployment} draft={deploymentDraft} task={configTask} busy={busy || disabled} runtimeActive={customDetectionActive && activeDetectionModelId === detail.id} onDraft={setDeploymentDraft} onSave={() => void saveDeployment()} onActivate={() => void runDeploymentTask(true)} onDeactivate={() => void runDeploymentTask(false)} />
      )}

      {deleteCandidate && (
        <div className="model-dialog" role="alertdialog" aria-labelledby="delete-model-title">
          <div><strong id="delete-model-title">{t("models.deleteTitle")}</strong><span>{deleteCandidate.referenced || deleteCandidate.active ? t("models.deleteReferenced") : t("models.deleteDetail", { name: deleteCandidate.name })}</span></div>
          <button type="button" className="button button--ghost" onClick={() => setDeleteCandidate(null)}>{t("common.cancel")}</button>
          <button type="button" className="button button--secondary" disabled={deleteCandidate.referenced || deleteCandidate.active || busy} onClick={() => void confirmDelete()}><Trash2 size={14} />{t("common.delete")}</button>
        </div>
      )}
    </div>
  );
}

function ModelListView({
  models,
  pendingImports,
  locale,
  isDeployable,
  disabled,
  onImport,
  onDetail,
  onDeployment,
  onActivate,
  onDeactivate,
  onDelete,
  activeDetectionModelId,
  customDetectionActive,
  operationState,
  pendingModelId,
}: {
  models: ModelSummary[];
  pendingImports: ImportTask[];
  locale: string;
  isDeployable: (model: ModelSummary) => boolean;
  disabled: boolean;
  onImport: (task: ImportTask) => void;
  onDetail: (id: string) => void;
  onDeployment: (id: string) => void;
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
  onDelete: (model: ModelSummary) => void;
  activeDetectionModelId: string | null;
  customDetectionActive: boolean;
  operationState: ModelOperationState;
  pendingModelId: string | null;
}) {
  const { t } = useTranslation();
  const sizeLabel = (value?: { width: number; height: number } | null) =>
    value ? `${value.width} × ${value.height}` : t("models.unknown");
  return (
    <div className="model-list-view">
      {pendingImports.length > 0 && (
        <div className="pending-imports">
          <h5>{t("models.pendingImports")}</h5>
          {pendingImports.map((task) => (
            <button type="button" key={task.id} onClick={() => onImport(task)}>
              <FileUp size={16} />
              <span><strong>{task.name}</strong><small>{task.importerId}</small></span>
              <output data-status={task.status}>{t(`models.importStatus.${task.status}`)}</output>
            </button>
          ))}
        </div>
      )}
      <div className="model-table">
        <div className="model-table__head">
          <span>{t("models.name")}</span>
          <span>{t("models.architecture")}</span>
          <span>{t("models.type")}</span>
          <span>{t("models.status")}</span>
          <span>{t("models.deployable")}</span>
          <span>{t("models.tensorSize")}</span>
          <span>{t("models.processingSize")}</span>
          <span>{t("models.threshold")}</span>
          <span>{t("models.size")}</span>
          <span />
        </div>
        {models.map((model) => {
          const processingSize =
            model.processingSize ?? model.deployment?.processingSize;
          const threshold = model.threshold ?? model.deployment?.threshold;
          const deployable = isDeployable(model);
          const runtimeActive =
            customDetectionActive && model.id === activeDetectionModelId;
          const operationApplies = pendingModelId === model.id;
          const runtimeStatus = operationApplies && operationState !== "idle"
            ? t(`models.operationStatus.${operationState}`)
            : runtimeActive
              ? t("models.operationStatus.running")
              : deployable
                ? t("models.operationStatus.deployed")
                : t("models.operationStatus.stopped");
          return (
            <div className="model-table__row" key={model.id}>
              <button type="button" className="model-table__identity" onClick={() => onDetail(model.id)}>
                <Box size={16} />
                <span><strong>{model.name}</strong><small>{model.importerId}</small></span>
              </button>
              <span>{model.modelType}</span>
              <span>{localizedModelTask(model.task, locale)}</span>
              <span className="model-status-stack">
                <i data-active={runtimeActive}>{runtimeStatus}</i>
                <small>{localizedModelStatus(model.status, locale)}</small>
              </span>
              <span>{deployable ? t("common.enabled") : t("common.unsupported")}</span>
              <span>{sizeLabel(model.tensorSize)}</span>
              <span>{sizeLabel(processingSize)}</span>
              <span>{threshold === undefined || threshold === null ? "-" : threshold.toFixed(2)}</span>
              <span>{formatBytes(model.fileSize)}</span>
              <span className="model-table__actions">
                <button type="button" className="icon-button" disabled={disabled} title={t("models.viewDetail")} onClick={() => onDetail(model.id)}><Box size={14} /></button>
                {deployable && <button type="button" className="icon-button" disabled={disabled} title={t("models.deployment")} onClick={() => onDeployment(model.id)}><Activity size={14} /></button>}
                {deployable && (runtimeActive
                  ? <button type="button" className="icon-button" disabled={disabled} title={t("models.deactivate")} onClick={() => onDeactivate(model.id)}><Pause size={14} /></button>
                  : <button type="button" className="icon-button" disabled={disabled} title={t("models.activate")} onClick={() => onActivate(model.id)}><Play size={14} /></button>)}
                <button type="button" className="icon-button" title={model.referenced || model.active || runtimeActive ? t("models.deleteReferenced") : t("common.delete")} disabled={disabled || model.referenced || model.active || runtimeActive} onClick={() => onDelete(model)}><Trash2 size={14} /></button>
              </span>
            </div>
          );
        })}
        {models.length === 0 && <div className="models-empty-state"><Box size={20} /><span>{t("models.empty")}</span></div>}
      </div>
    </div>
  );
}

function ImportTaskView({ task, progress, file, busy, onFile, onRetry, onCommit, onCancel, onCancelUpload }: { task: ImportTask; progress: UploadProgress | null; file: File | null; busy: boolean; onFile: (file: File | null) => void; onRetry: () => void; onCommit: () => void; onCancel: () => void; onCancelUpload: () => void }) {
  const { t, i18n } = useTranslation();
  const canUpload = task.status === "created" || task.status === "failed";
  const validationError = task.validationError ?? task.error;
  return <div className="import-task-view"><header><FileUp size={20} /><span><strong>{task.name}</strong><small>{task.id} · {task.importerId}</small></span><output data-status={task.status}>{t(`models.importStatus.${task.status}`)}</output></header><dl><div><dt>{t("models.size")}</dt><dd>{formatBytes(task.fileSize)}</dd></div><div><dt>{t("models.uploaded")}</dt><dd>{formatBytes(task.uploadedBytes)}</dd></div><div><dt>{t("models.created")}</dt><dd>{formatDate(task.createdAt, undefined)}</dd></div></dl>{progress && <div className="model-upload-progress"><span><span style={{ width: `${progress.percent}%` }} /></span><output>{progress.percent.toFixed(0)}% · {formatBytes(progress.loaded)} / {formatBytes(progress.total)}</output></div>}{validationError && <div className="model-validation-error" role="alert">{localizedRuntimeText(validationError, t("models.importValidationFailed"), i18n.language)}</div>}{canUpload && <label className="model-retry-file"><span>{t("models.selectFullFile")}</span><input type="file" accept=".bmodel,application/octet-stream" onChange={(event) => onFile(event.target.files?.[0] ?? null)} /><small>{file ? `${file.name} · ${formatBytes(file.size)}` : t("models.noFile")}</small></label>}<footer>{busy && progress && progress.percent < 100 ? <button className="button button--ghost" type="button" onClick={onCancelUpload}><X size={14} />{t("models.cancelUpload")}</button> : <button className="button button--ghost" type="button" disabled={busy} onClick={onCancel}><Trash2 size={14} />{t("models.cancelImport")}</button>}{canUpload && <button className="button button--secondary" type="button" disabled={!file || busy} onClick={onRetry}><RefreshCw size={14} />{t("models.retryFullUpload")}</button>}{task.status === "uploaded" && <button className="button button--primary" type="button" disabled={busy} onClick={onCommit}>{busy ? <LoaderCircle className="button-spinner" size={14} /> : <CheckCircle2 size={14} />}{t("models.validateAndCommit")}</button>}</footer></div>;
}

function ModelDetailView({ model, importer, locale, deployable, runtimeActive, onDeployment, onDeactivate, onDelete, busy }: { model: ModelDetail; importer: ModelImporter | null; locale: string; deployable: boolean; runtimeActive: boolean; onDeployment: () => void; onDeactivate: () => void; onDelete: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const sizeLabel = (size?: { width: number; height: number } | null) =>
    size ? `${size.width} × ${size.height}` : t("models.unknown");
  return <div className="model-detail-view"><header><Box size={22} /><div><span>{model.importerId}</span><h4>{model.name}</h4><small>{model.id}</small></div><output data-active={runtimeActive}>{runtimeActive ? t("models.operationStatus.running") : t("models.operationStatus.deployed")}</output></header><dl><div><dt>{t("models.architecture")}</dt><dd>{model.modelType}</dd></div><div><dt>{t("models.type")}</dt><dd>{localizedModelTask(model.task, locale)}</dd></div><div><dt>{t("models.tensorSize")}</dt><dd>{sizeLabel(model.tensorSize)}</dd></div><div><dt>{t("models.processingSize")}</dt><dd>{sizeLabel(model.deployment?.processingSize)}</dd></div><div><dt>{t("models.size")}</dt><dd>{formatBytes(model.fileSize)}</dd></div><div><dt>{t("models.committed")}</dt><dd>{formatDate(model.committedAt, locale)}</dd></div><div><dt>{t("models.checksum")}</dt><dd>{model.checksum ?? "-"}</dd></div><div><dt>{t("models.consumer")}</dt><dd>{importer?.runtimeConsumers.join(", ") || t("models.noConsumer")}</dd></div></dl><div className="model-metadata"><h5>{t("models.metadata")}</h5><pre>{JSON.stringify(model.metadata, null, 2)}</pre></div><footer>{deployable && <button className="button button--secondary" type="button" disabled={busy} onClick={onDeployment}><Activity size={14} />{t("models.deployment")}</button>}{runtimeActive && <button className="button button--ghost" type="button" disabled={busy} onClick={onDeactivate}><Pause size={14} />{t("models.deactivate")}</button>}<button className="button button--ghost" type="button" disabled={busy || model.referenced || runtimeActive} onClick={onDelete}><Trash2 size={14} />{t("common.delete")}</button></footer></div>;
}

function ModelDeploymentView({ model, importer, deployment, draft, task, busy, runtimeActive, onDraft, onSave, onActivate, onDeactivate }: { model: ModelDetail; importer: ModelImporter | null; deployment: DeploymentState; draft: DeploymentParameters; task: ModelTask | null; busy: boolean; runtimeActive: boolean; onDraft: (parameters: DeploymentParameters) => void; onSave: () => void; onActivate: () => void; onDeactivate: () => void }) {
  const { t, i18n } = useTranslation();
  const schema = deployment.parameterSchema as Record<string, RuntimeJsonSchema>;
  const threshold = schema.threshold ?? {};
  const processingSchema = schema.processingSize ?? {};
  const importerDeploymentSchema = importer?.deploymentSchema as
    | RuntimeJsonSchema
    | null
    | undefined;
  const importerProcessingSchema =
    importerDeploymentSchema?.properties?.processingSize ??
    ((importerDeploymentSchema as Record<string, RuntimeJsonSchema> | undefined)
      ?.processingSize ?? {});
  const processingConstraints = normalizeModelSizeConstraints(
    deployment.processingSizeConstraints ??
      processingSchema.constraints ??
      (Number.isFinite(processingSchema.minWidth)
        ? {
            minWidth: processingSchema.minWidth,
            maxWidth: processingSchema.maxWidth,
            minHeight: processingSchema.minHeight,
            maxHeight: processingSchema.maxHeight,
            step: processingSchema.step,
          }
        : undefined) ??
      importerProcessingSchema.constraints ??
      (Number.isFinite(importerProcessingSchema.minWidth)
        ? {
            minWidth: importerProcessingSchema.minWidth,
            maxWidth: importerProcessingSchema.maxWidth,
            minHeight: importerProcessingSchema.minHeight,
            maxHeight: importerProcessingSchema.maxHeight,
            step: importerProcessingSchema.step,
          }
        : undefined),
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(deployment.parameters);
  const unapplied =
    JSON.stringify(deployment.parameters) !==
    JSON.stringify(deployment.appliedParameters);
  return <div className="model-deployment-view"><header><Activity size={20} /><span><strong>{model.name}</strong><small>{t("models.deploymentDetail")}</small></span><output data-active={runtimeActive}>{runtimeActive ? t("models.operationStatus.running") : t("models.operationStatus.deployed")}</output></header>{unapplied && <div className="model-unapplied-status">{t("models.unappliedChanges")}</div>}<label className="model-deployment-field"><span>{t("models.threshold")}</span><input type="range" min={threshold.minimum ?? 0} max={threshold.maximum ?? 1} step={threshold.step ?? 0.01} value={draft.threshold} disabled={busy} onChange={(event) => onDraft({ ...draft, threshold: Number(event.target.value) })} /><input type="number" min={threshold.minimum ?? 0} max={threshold.maximum ?? 1} step={threshold.step ?? 0.01} value={draft.threshold} disabled={busy} onChange={(event) => onDraft({ ...draft, threshold: Number(event.target.value) })} /></label>{processingConstraints && draft.processingSize && <div className="model-deployment-size"><span>{t("models.processingSize")}</span><select value={processingConstraints.presets.some((preset) => preset.width === draft.processingSize?.width && preset.height === draft.processingSize?.height) ? `${draft.processingSize.width}x${draft.processingSize.height}` : "custom"} disabled={busy} onChange={(event) => { if (event.target.value === "custom") return; const [width, height] = event.target.value.split("x").map(Number); onDraft({ ...draft, processingSize: { width, height } }); }}>{processingConstraints.presets.map((preset) => <option key={`${preset.width}x${preset.height}`} value={`${preset.width}x${preset.height}`}>{preset.width} × {preset.height}</option>)}<option value="custom">{t("config.processingSize.custom")}</option></select><input aria-label={t("config.processingSize.width")} type="number" min={processingConstraints.minWidth} max={processingConstraints.maxWidth} step={processingConstraints.widthStep} value={draft.processingSize.width} disabled={busy} onChange={(event) => onDraft({ ...draft, processingSize: { ...draft.processingSize!, width: Number(event.target.value) } })} /><span>×</span><input aria-label={t("config.processingSize.height")} type="number" min={processingConstraints.minHeight} max={processingConstraints.maxHeight} step={processingConstraints.heightStep} value={draft.processingSize.height} disabled={busy} onChange={(event) => onDraft({ ...draft, processingSize: { ...draft.processingSize!, height: Number(event.target.value) } })} /></div>}<dl><div><dt>{t("models.tensorSize")}</dt><dd>{model.tensorSize ? `${model.tensorSize.width} × ${model.tensorSize.height}` : t("models.unknown")}</dd></div><div><dt>{t("models.savedParameters")}</dt><dd>{JSON.stringify(deployment.parameters)}</dd></div><div><dt>{t("models.appliedParameters")}</dt><dd>{deployment.appliedParameters ? JSON.stringify(deployment.appliedParameters) : "-"}</dd></div></dl>{task && <div className="model-task-progress"><span><span style={{ width: `${task.progress}%` }} /></span><output>{localizedTaskMessage(task, i18n.language)} · {task.progress}%</output></div>}<footer><button className="button button--secondary" type="button" disabled={!dirty || busy} onClick={onSave}><Save size={14} />{runtimeActive ? t("models.saveAndApply") : t("models.saveDeployment")}</button>{runtimeActive ? <button className="button button--ghost" type="button" disabled={busy || dirty} onClick={onDeactivate}><Pause size={14} />{t("models.deactivate")}</button> : <button className="button button--primary" type="button" disabled={busy || dirty} onClick={onActivate}><Play size={14} />{t("models.activate")}</button>}</footer></div>;
}
