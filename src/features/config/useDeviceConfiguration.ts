import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import i18n from "../../i18n";
import type { OvisDeviceInfo } from "../device/device.types";
import {
  ConfigRequestError,
  applyConfig,
  getConfigCapabilities,
  getConfigTask,
  getCurrentConfig,
  resetConfig,
  saveConfig,
  validateConfig,
} from "./config.api";
import {
  CONFIG_RECONNECT_TIMEOUT_MS,
  ConfigReconnectTimeoutError,
  reconnectConfigDevice,
} from "./config.recovery";
import {
  clearPendingConfigApplication,
  readPendingConfigApplication,
  writePendingConfigApplication,
} from "./config.session";
import type { PendingConfigApplication } from "./config.session";
import type {
  AiFeatureCapability,
  ConfigApplicationState,
  ConfigApplicationConfirmation,
  ConfigCapabilities,
  ConfigIssue,
  ConfigPayload,
  ConfigSaveScope,
  ConfigTask,
  ConfigValidationResponse,
  ConfigurationOutcome,
  ConfigurationStatus,
  DeviceConfigDocument,
  DeviceConfigValues,
  OverlayConfigValues,
  OverlayTextPosition,
  ProcessingSize,
  ProcessingSizeCapability,
  SerializedDeviceConfigValues,
  TpuFeatureId,
} from "./config.types";

const TASK_VERIFY_INTERVAL_MS = 1_500;
const MAX_RESET_TASK_POLLS = 60;

const cloneValues = (values: DeviceConfigValues) => structuredClone(values);

const OVERLAY_TEXT_POSITIONS: OverlayTextPosition[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "custom",
];

const defaultOverlayValues = (enabled = false): OverlayConfigValues => ({
  enabled,
  texts: [
    {
      id: "primary",
      enabled: false,
      content: "",
      streams: ["main"],
      position: "top-left",
      x: 20,
      y: 40,
      color: "#FFFFFF",
    },
  ],
  detection: {
    enabled: false,
    colorMode: "fixed",
    color: "#00D9FF",
    thickness: 2,
    labelMode: "none",
  },
  tracking: {
    enabled: false,
    color: "#FFB000",
    lostColor: "#FF3030",
    boxStyle: "rectangle",
    hideWhenLost: false,
    thickness: 3,
  },
  reticle: {
    enabled: false,
    template: "corners",
    idleColor: "#FFFFFF",
    readyColor: "#FFC247",
    thickness: 2,
    showWhileTracking: false,
  },
});

const normalizeOverlayValues = (value: unknown): OverlayConfigValues => {
  const raw =
    typeof value === "object" && value !== null
      ? (value as Partial<OverlayConfigValues>)
      : {};
  const defaults = defaultOverlayValues(raw.enabled === true);
  const rawTexts = Array.isArray(raw.texts) ? raw.texts : [];
  const texts = rawTexts.map((entry, index) => {
    const text = entry as Partial<OverlayConfigValues["texts"][number]>;
    return {
      id: typeof text.id === "string" && text.id ? text.id : `text-${index + 1}`,
      enabled: text.enabled === true,
      content: typeof text.content === "string" ? text.content : "",
      streams:
        Array.isArray(text.streams) && text.streams.every((stream) => typeof stream === "string")
          ? text.streams
          : ["main"],
      position: OVERLAY_TEXT_POSITIONS.includes(text.position as OverlayTextPosition)
        ? (text.position as OverlayTextPosition)
        : "top-left",
      x: Number.isFinite(text.x) ? Number(text.x) : 20,
      y: Number.isFinite(text.y) ? Number(text.y) : 40,
      color: typeof text.color === "string" ? text.color : "#FFFFFF",
    };
  });

  return {
    enabled: raw.enabled === true,
    texts: texts.length > 0 ? texts : defaults.texts,
    detection: {
      ...defaults.detection,
      ...(raw.detection ?? {}),
    },
    tracking: {
      ...defaults.tracking,
      ...(raw.tracking ?? {}),
    },
    reticle: {
      ...defaults.reticle,
      ...(raw.reticle ?? {}),
    },
  };
};

const normalizeDetectionModel = (model: unknown): string => {
  if (typeof model === "string" && model.trim()) return model;
  if (typeof model === "object" && model !== null) {
    const legacy = model as { source?: unknown; id?: unknown; runtime_model?: unknown };
    if (legacy.source === "custom" && typeof legacy.id === "string") {
      return legacy.id;
    }
    if (
      typeof legacy.runtime_model === "string" &&
      /PERSON.*VEHICLE|VEHICLE.*PERSON/i.test(legacy.runtime_model)
    ) {
      return "builtin.person_vehicle_detection";
    }
  }
  return "builtin.person_detection";
};

const normalizeConfigValues = (values: DeviceConfigValues): DeviceConfigValues => {
  const normalized = cloneValues(values);
  const raw = values as unknown as {
    detection: DeviceConfigValues["detection"] & {
      object: Omit<DeviceConfigValues["detection"]["object"], "model"> & {
        model: unknown;
      };
      object_tracking?: {
        enabled?: boolean;
        search_method?: "color" | "fastsam";
        use_kalman?: boolean;
        score_threshold?: number;
        tracking_processing_size?: ProcessingSize;
      };
    };
    tracking?: Partial<DeviceConfigValues["tracking"]>;
  };
  normalized.overlay = normalizeOverlayValues(values.overlay);
  normalized.detection.object.model = normalizeDetectionModel(raw.detection.object.model);

  const legacyTracking = raw.detection.object_tracking;
  const currentTracking = raw.tracking?.single_object;
  const defaultSource =
    currentTracking?.default_target_source ?? legacyTracking?.search_method ?? "box";
  const fallbackSource =
    currentTracking?.fallback_target_source ??
    (defaultSource === "detection" ? "box" : defaultSource);
  normalized.tracking = {
    single_object: {
      enabled: currentTracking?.enabled ?? legacyTracking?.enabled === true,
      default_target_source: defaultSource,
      fallback_target_source: fallbackSource,
      selection_mode: currentTracking?.selection_mode ?? "point",
      initial_box_mode: currentTracking?.initial_box_mode ?? "target",
      score_threshold:
        currentTracking?.score_threshold ?? legacyTracking?.score_threshold ?? 0.5,
      use_kalman: currentTracking?.use_kalman ?? legacyTracking?.use_kalman ?? true,
      processing_size:
        currentTracking?.processing_size ??
        legacyTracking?.tracking_processing_size ??
        { width: 1920, height: 1080 },
      fastsam: {
        threshold: currentTracking?.fastsam?.threshold ?? 0.5,
      },
      color: {
        tolerance: currentTracking?.color?.tolerance ?? 30,
      },
    },
  };
  if (legacyTracking?.enabled) normalized.detection.object.enabled = true;
  return normalized;
};

const normalizeOutputMode = (
  values: DeviceConfigValues,
): DeviceConfigValues => {
  const normalized = cloneValues(values);
  const rawOutputs = (values as {
    outputs?: {
      rtsp?: { enabled?: unknown };
      uvc?: { enabled?: unknown };
      display?: { enabled?: unknown; mode?: unknown };
    };
  }).outputs;
  const rtspEnabled = rawOutputs?.rtsp?.enabled === true;
  const uvcEnabled = rawOutputs?.uvc?.enabled === true;
  const displayOutput = rawOutputs?.display;
  const useRtsp = rtspEnabled && !uvcEnabled;
  normalized.outputs = {
    rtsp: { enabled: useRtsp },
    uvc: { enabled: !useRtsp },
    ...(typeof displayOutput?.enabled === "boolean" &&
      typeof displayOutput.mode === "string"
      ? {
          display: {
            enabled: displayOutput.enabled,
            mode: displayOutput.mode,
          },
        }
      : {}),
  };
  return normalized;
};

const serializeConfigValues = (
  values: DeviceConfigValues,
  capabilities: ConfigCapabilities,
): SerializedDeviceConfigValues => {
  const serialized: SerializedDeviceConfigValues = {
    video: {
      main: {
        profile: values.video.main.profile,
        fps: values.video.main.fps,
        bitrate_kbps: values.video.main.bitrate_kbps,
      },
      sub: {
        enabled: values.video.sub.enabled,
        profile: values.video.sub.profile,
        fps: values.video.sub.fps,
        bitrate_kbps: values.video.sub.bitrate_kbps,
      },
    },
    overlay: capabilities.overlay?.supported
      ? {
          enabled: values.overlay.enabled,
          texts: values.overlay.texts.map((text) => ({
            id: text.id,
            enabled: text.enabled,
            content: text.content,
            streams: [...text.streams],
            position: text.position,
            x: text.x,
            y: text.y,
            color: text.color,
          })),
          detection: { ...values.overlay.detection },
          tracking: {
            enabled: values.overlay.tracking.enabled,
            color: values.overlay.tracking.color,
            lostColor: values.overlay.tracking.lostColor,
            thickness: values.overlay.tracking.thickness,
            ...(capabilities.overlay?.trackingBoxStyles?.length ? {
              boxStyle: values.overlay.tracking.boxStyle ?? "rectangle",
            } : {}),
            ...(capabilities.overlay?.trackingHideWhenLost ? {
              hideWhenLost: values.overlay.tracking.hideWhenLost ?? false,
            } : {}),
          },
          reticle: { ...values.overlay.reticle },
        }
      : { enabled: values.overlay.enabled },
    detection: {
      object: {
        enabled: values.detection.object.enabled,
        model: values.detection.object.model,
        threshold: values.detection.object.threshold,
        processing_size: { ...values.detection.object.processing_size },
      },
      face: {
        enabled: values.detection.face.enabled,
        threshold: values.detection.face.threshold,
        ...(values.detection.face.processing_size
          ? { processing_size: { ...values.detection.face.processing_size } }
          : {}),
      },
      motion: {
        enabled: values.detection.motion.enabled,
        sensitivity: values.detection.motion.sensitivity,
        ...(values.detection.motion.processing_size
          ? { processing_size: { ...values.detection.motion.processing_size } }
          : {}),
      },
    },
    tracking: {
      single_object: {
        enabled: values.tracking.single_object.enabled,
        default_target_source:
          values.tracking.single_object.default_target_source,
        fallback_target_source:
          values.tracking.single_object.fallback_target_source,
        score_threshold: values.tracking.single_object.score_threshold,
        use_kalman: values.tracking.single_object.use_kalman,
        processing_size: {
          ...values.tracking.single_object.processing_size,
        },
        fastsam: { ...values.tracking.single_object.fastsam },
        color: { ...values.tracking.single_object.color },
      },
    },
  };

  const trackingCapability = capabilities.ai?.features.find((feature) =>
    ["single_object_tracking", "object_tracking"].includes(feature.id),
  );
  if (trackingCapability?.selection_modes?.length) {
    serialized.tracking.single_object.selection_mode =
      values.tracking.single_object.selection_mode ?? "point";
  }
  if (trackingCapability?.initial_box_modes?.length) {
    serialized.tracking.single_object.initial_box_mode =
      values.tracking.single_object.initial_box_mode ?? "target";
  }

  if (values.ai_isp) {
    serialized.ai_isp = {
      bnr: { enabled: values.ai_isp.bnr.enabled },
    };
  }

  const outputValues = normalizeOutputMode(values).outputs!;
  serialized.outputs = {
    rtsp: { enabled: outputValues.rtsp.enabled },
    uvc: { enabled: outputValues.uvc.enabled },
    ...(outputValues.display
      ? {
          display: {
            enabled: outputValues.display.enabled,
            mode: outputValues.display.mode,
          },
        }
      : {}),
  };

  if (values.detection.human_pose) {
    serialized.detection.human_pose = {
      enabled: values.detection.human_pose.enabled,
      threshold: values.detection.human_pose.threshold,
      ...(values.detection.human_pose.processing_size
        ? { processing_size: { ...values.detection.human_pose.processing_size } }
        : {}),
    };
  }
  return serialized;
};

const formatError = (error: unknown) => {
  if (error instanceof ConfigRequestError) return error.message;
  if (error instanceof ConfigReconnectTimeoutError) return error.message;
  return i18n.t("config.validation.operationFailed");
};

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

const TPU_FEATURE_IDS: TpuFeatureId[] = [
  "object",
  "face",
  "human_pose",
];

const isTpuFeatureId = (value: string): value is TpuFeatureId =>
  TPU_FEATURE_IDS.includes(value as TpuFeatureId);

const featureProcessingSize = (feature: AiFeatureCapability) =>
  feature.processing_size ?? feature.processingSize;

const processingSizeConstraints = (
  capability: ProcessingSizeCapability,
) => {
  if (capability.constraints) return capability.constraints;
  if (
    Number.isFinite(capability.min_width) &&
    Number.isFinite(capability.max_width) &&
    Number.isFinite(capability.min_height) &&
    Number.isFinite(capability.max_height) &&
    Number.isFinite(capability.step)
  ) {
    return {
      minWidth: capability.min_width,
      maxWidth: capability.max_width,
      minHeight: capability.min_height,
      maxHeight: capability.max_height,
      widthStep: capability.step,
      heightStep: capability.step,
      presets: capability.default ? [capability.default] : [],
    };
  }
  return undefined;
};

const validateProcessingSize = (
  field: string,
  value: ProcessingSize | undefined,
  capability: ProcessingSizeCapability | undefined,
  errors: ConfigIssue[],
) => {
  if (!capability || !value) return;
  if (capability.fixed) {
    if (value.width !== capability.width || value.height !== capability.height) {
      errors.push({
        field,
        code: "INVALID_PROCESSING_SIZE",
        message: i18n.t("config.validation.invalidProcessingSize"),
      });
    }
    return;
  }
  const constraints = processingSizeConstraints(capability);
  if (!constraints) return;
  if (
    !Number.isFinite(constraints.minWidth) ||
    !Number.isFinite(constraints.maxWidth) ||
    !Number.isFinite(constraints.minHeight) ||
    !Number.isFinite(constraints.maxHeight) ||
    !Number.isFinite(constraints.widthStep) ||
    !Number.isFinite(constraints.heightStep) ||
    (constraints.widthStep ?? 0) <= 0 ||
    (constraints.heightStep ?? 0) <= 0
  ) {
    return;
  }
  const valid =
    Number.isInteger(value.width) &&
    Number.isInteger(value.height) &&
    value.width >= constraints.minWidth! &&
    value.width <= constraints.maxWidth! &&
    value.height >= constraints.minHeight! &&
    value.height <= constraints.maxHeight! &&
    (value.width - constraints.minWidth!) % constraints.widthStep! === 0 &&
    (value.height - constraints.minHeight!) % constraints.heightStep! === 0;
  if (!valid) {
    errors.push({
      field,
      code: "INVALID_PROCESSING_SIZE",
      message: i18n.t("config.validation.invalidProcessingSize"),
    });
  }
};

const tpuFeatureEnabled = (
  values: DeviceConfigValues,
  featureId: TpuFeatureId,
) => {
  if (featureId === "object" || featureId === "face") {
    return values.detection[featureId].enabled;
  }
  return values.detection[featureId]?.enabled === true;
};

const aiFeatureEnabled = (values: DeviceConfigValues, featureId: string) => {
  if (featureId === "motion") return values.detection.motion.enabled;
  if (
    featureId === "tracking" ||
    featureId === "single_object_tracking" ||
    featureId === "object_tracking"
  ) {
    return values.tracking.single_object.enabled;
  }
  if (isTpuFeatureId(featureId)) return tpuFeatureEnabled(values, featureId);
  return false;
};

const assertCompleteConfigDocument = (
  capabilities: ConfigCapabilities,
  document: DeviceConfigDocument,
) => {
  if (
    (capabilities.schema_version >= 5 &&
      typeof document.values.ai_isp?.bnr.enabled !== "boolean") ||
    (capabilities.schema_version >= 7 &&
      capabilities.outputs?.display?.supported === true &&
      (typeof document.values.outputs?.display?.enabled !== "boolean" ||
        typeof document.values.outputs.display.mode !== "string"))
  ) {
    throw new ConfigRequestError(i18n.t("config.validation.invalidData"));
  }
};

function validateDraftLocally(
  capabilities: ConfigCapabilities,
  values: DeviceConfigValues,
): ConfigIssue[] {
  const errors: ConfigIssue[] = [];

  const bnrCapability = capabilities.ai_isp?.bnr;
  const bnrEnabled = values.ai_isp?.bnr.enabled === true;
  if (
    capabilities.schema_version >= 5 &&
    typeof values.ai_isp?.bnr.enabled !== "boolean"
  ) {
    errors.push({
      field: "ai_isp.bnr.enabled",
      code: "INCOMPLETE_CONFIG",
      message: i18n.t("config.validation.invalidData"),
    });
  } else if (bnrEnabled && bnrCapability?.supported !== true) {
    errors.push({
      field: "ai_isp.bnr.enabled",
      code: "AI_BNR_UNSUPPORTED",
      message: i18n.t("config.validation.aiBnrUnsupported"),
    });
  }
  const requiredMainFps = bnrCapability?.required_main_fps ?? 30;
  if (bnrEnabled && values.video.main.fps !== requiredMainFps) {
    errors.push({
      field: "video.main.fps",
      code: "AI_BNR_REQUIRES_FPS",
      message: i18n.t("config.validation.aiBnrRequiresFps", {
        fps: requiredMainFps,
      }),
    });
  }
  if (
    bnrEnabled &&
    (bnrCapability?.exclusive_with ?? []).some((featureId) =>
      aiFeatureEnabled(values, featureId),
    )
  ) {
    errors.push({
      field: "ai_isp.bnr.enabled",
      code: "AI_BNR_FEATURE_CONFLICT",
      message: i18n.t("config.validation.aiBnrConflict"),
    });
  }

  const uvcEnabled = values.outputs?.uvc.enabled;
  const rtspOutputEnabled = values.outputs?.rtsp.enabled;
  if (
    typeof uvcEnabled !== "boolean" ||
    typeof rtspOutputEnabled !== "boolean" ||
    uvcEnabled === rtspOutputEnabled
  ) {
    errors.push({
      field: "outputs",
      code: "INVALID_OUTPUT_MODE",
      message: i18n.t("config.validation.invalidOutputMode"),
    });
  }

  const displayCapability = capabilities.outputs?.display;
  const displayValues = values.outputs?.display;
  if (
    displayCapability?.supported === true &&
    (typeof displayValues?.enabled !== "boolean" ||
      typeof displayValues.mode !== "string" ||
      !displayCapability.modes.some((mode) => mode.id === displayValues.mode))
  ) {
    errors.push({
      field: "outputs.display",
      code: "INVALID_DISPLAY_MODE",
      message: i18n.t("config.validation.invalidDisplayMode"),
    });
  }

  const overlayCapability = capabilities.overlay;
  if (overlayCapability?.supported) {
    const overlay = values.overlay;
    const addOverlayError = (field: string, code: string, message: string) =>
      errors.push({ field: `values.${field}`, path: `values.${field}`, code, message });
    const validColor = (color: string) => /^#[0-9A-Fa-f]{6}$/.test(color);
    const validateColor = (field: string, color: string) => {
      if (!validColor(color)) {
        addOverlayError(field, "invalid_color", i18n.t("config.overlay.validation.color"));
      }
    };
    const validateThickness = (field: string, thickness: number) => {
      if (
        !Number.isInteger(thickness) ||
        thickness < overlayCapability.thickness.min ||
        thickness > overlayCapability.thickness.max
      ) {
        addOverlayError(
          field,
          "out_of_range",
          i18n.t("config.overlay.validation.thickness", {
            min: overlayCapability.thickness.min,
            max: overlayCapability.thickness.max,
          }),
        );
      }
    };

    if (overlay.texts.length > overlayCapability.maxTexts) {
      addOverlayError(
        "overlay.texts",
        "too_many_items",
        i18n.t("config.overlay.validation.maxTexts", {
          count: overlayCapability.maxTexts,
        }),
      );
    }
    const mainProfile = capabilities.video.main.profiles.find(
      (profile) => profile.id === values.video.main.profile,
    );
    overlay.texts.forEach((text, index) => {
      const field = `overlay.texts.${index}`;
      const byteLength = new TextEncoder().encode(text.content).length;
      const hasControlCharacter = Array.from(text.content).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || codePoint === 127;
      });
      if (
        byteLength > overlayCapability.textMaxBytes ||
        hasControlCharacter ||
        (!overlayCapability.utf8Text && !/^[\x20-\x7E]*$/.test(text.content))
      ) {
        addOverlayError(
          `${field}.content`,
          "invalid_text",
          i18n.t("config.overlay.validation.text", {
            count: overlayCapability.textMaxBytes,
          }),
        );
      }
      validateColor(`${field}.color`, text.color);
      if (!text.streams.includes("main")) {
        addOverlayError(
          `${field}.streams`,
          "main_stream_required",
          i18n.t("config.overlay.validation.mainStream"),
        );
      }
      if (
        mainProfile &&
        (!Number.isInteger(text.x) ||
          !Number.isInteger(text.y) ||
          text.x < 0 ||
          text.x >= mainProfile.width ||
          text.y < 0 ||
          text.y >= mainProfile.height)
      ) {
        addOverlayError(
          field,
          "out_of_range",
          i18n.t("config.overlay.validation.position"),
        );
      }
    });

    validateColor("overlay.detection.color", overlay.detection.color);
    validateColor("overlay.tracking.color", overlay.tracking.color);
    validateColor("overlay.tracking.lostColor", overlay.tracking.lostColor);
    validateColor("overlay.reticle.idleColor", overlay.reticle.idleColor);
    validateColor("overlay.reticle.readyColor", overlay.reticle.readyColor);
    validateThickness("overlay.detection.thickness", overlay.detection.thickness);
    validateThickness("overlay.tracking.thickness", overlay.tracking.thickness);
    validateThickness("overlay.reticle.thickness", overlay.reticle.thickness);

    if (!overlayCapability.colorModes.includes(overlay.detection.colorMode)) {
      addOverlayError(
        "overlay.detection.colorMode",
        "unsupported_value",
        i18n.t("config.overlay.validation.unsupported"),
      );
    }
    if (!overlayCapability.labelModes.includes(overlay.detection.labelMode)) {
      addOverlayError(
        "overlay.detection.labelMode",
        "unsupported_value",
        i18n.t("config.overlay.validation.unsupported"),
      );
    }
    if (!overlayCapability.reticleTemplates.includes(overlay.reticle.template)) {
      addOverlayError(
        "overlay.reticle.template",
        "unsupported_value",
        i18n.t("config.overlay.validation.unsupported"),
      );
    }
  }

  const validateStream = (
    field: "video.main" | "video.sub",
    stream: DeviceConfigValues["video"]["main"],
    profiles: ConfigCapabilities["video"]["main"]["profiles"],
    validateBitrate = true,
  ) => {
    const profile = profiles.find((entry) => entry.id === stream.profile);
    if (profiles.length > 0 && !profile) {
      errors.push({
        field: `${field}.profile`,
        code: "UNSUPPORTED_PROFILE",
        message: i18n.t("config.validation.unsupportedProfile"),
      });
      return;
    }
    if (!Number.isInteger(stream.fps) || stream.fps <= 0) {
      errors.push({
        field: `${field}.fps`,
        code: "INVALID_FPS",
        message: i18n.t("config.validation.invalidFps"),
      });
    } else if (profile && !profile.fps_options.includes(stream.fps)) {
      errors.push({
        field: `${field}.fps`,
        code: "UNSUPPORTED_FPS",
        message: i18n.t("config.validation.unsupportedFps"),
      });
    }
    if (
      validateBitrate &&
      (!Number.isInteger(stream.bitrate_kbps) || stream.bitrate_kbps <= 0)
    ) {
      errors.push({
        field: `${field}.bitrate_kbps`,
        code: "INVALID_BITRATE",
        message: i18n.t("config.validation.invalidBitrate"),
      });
    } else if (
      validateBitrate &&
      profile &&
      (stream.bitrate_kbps < profile.bitrate_min ||
        stream.bitrate_kbps > profile.bitrate_max)
    ) {
      errors.push({
        field: `${field}.bitrate_kbps`,
        code: "OUT_OF_RANGE",
        message: i18n.t("config.validation.bitrateRange", {
          min: profile.bitrate_min,
          max: profile.bitrate_max,
        }),
      });
    }
  };

  const rtspEnabled =
    capabilities.outputs?.rtsp.supported !== true ||
    values.outputs?.rtsp.enabled === true;
  validateStream(
    "video.main",
    values.video.main,
    capabilities.video.main.profiles,
    rtspEnabled,
  );
  if (rtspEnabled && values.video.sub.enabled) {
    validateStream("video.sub", values.video.sub, capabilities.video.sub.profiles);
  }

  const thresholdFields: Array<[string, number | undefined]> = [];
  (capabilities.ai?.features ?? []).forEach((feature) => {
    if (feature.id === "object" || feature.id === "face") {
      thresholdFields.push([
        `detection.${feature.id}.threshold`,
        values.detection[feature.id].threshold,
      ]);
    } else if (feature.id === "human_pose") {
      thresholdFields.push([
        "detection.human_pose.threshold",
        values.detection.human_pose?.threshold,
      ]);
    }
  });
  thresholdFields.push([
    "tracking.single_object.score_threshold",
    values.tracking.single_object.score_threshold,
  ]);
  thresholdFields.push([
    "tracking.single_object.fastsam.threshold",
    values.tracking.single_object.fastsam.threshold,
  ]);
  thresholdFields.forEach(([field, value]) => {
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
      errors.push({
        field,
        code: "OUT_OF_RANGE",
        message: i18n.t("config.validation.thresholdRange"),
      });
    }
  });
  (capabilities.ai?.features ?? []).forEach((feature) => {
    if (feature.id === "object") {
      validateProcessingSize(
        "detection.object.processing_size",
        values.detection.object.processing_size,
        featureProcessingSize(feature),
        errors,
      );
    } else if (feature.id === "face") {
      validateProcessingSize(
        "detection.face.processing_size",
        values.detection.face.processing_size,
        featureProcessingSize(feature),
        errors,
      );
    } else if (feature.id === "human_pose") {
      validateProcessingSize(
        "detection.human_pose.processing_size",
        values.detection.human_pose?.processing_size,
        featureProcessingSize(feature),
        errors,
      );
    }
  });
  const trackingCapability = (capabilities.ai?.features ?? []).find(
    (feature) =>
      feature.id === "single_object_tracking" || feature.id === "object_tracking",
  );
  if (trackingCapability?.selection_modes?.length &&
      !trackingCapability.selection_modes.includes(values.tracking.single_object.selection_mode ?? "point")) {
    errors.push({ field: "tracking.single_object.selection_mode", code: "UNSUPPORTED_VALUE", message: i18n.t("config.validation.trackingOption") });
  }
  if (trackingCapability?.initial_box_modes?.length &&
      !trackingCapability.initial_box_modes.includes(values.tracking.single_object.initial_box_mode ?? "target")) {
    errors.push({ field: "tracking.single_object.initial_box_mode", code: "UNSUPPORTED_VALUE", message: i18n.t("config.validation.trackingOption") });
  }
  if (capabilities.overlay?.trackingBoxStyles?.length &&
      !capabilities.overlay.trackingBoxStyles.includes(values.overlay.tracking.boxStyle ?? "rectangle")) {
    errors.push({ field: "overlay.tracking.boxStyle", code: "UNSUPPORTED_VALUE", message: i18n.t("config.validation.trackingOption") });
  }
  if (capabilities.overlay?.trackingHideWhenLost &&
      values.overlay.tracking.hideWhenLost !== undefined && typeof values.overlay.tracking.hideWhenLost !== "boolean") {
    errors.push({ field: "overlay.tracking.hideWhenLost", code: "UNSUPPORTED_VALUE", message: i18n.t("config.validation.trackingOption") });
  }
  validateProcessingSize(
    "tracking.single_object.processing_size",
    values.tracking.single_object.processing_size,
    trackingCapability?.processing_size ??
      trackingCapability?.processingSize ??
      trackingCapability?.tracking_processing_size ??
      trackingCapability?.trackingProcessingSize,
    errors,
  );
  if (
    !Number.isFinite(values.tracking.single_object.color.tolerance) ||
    values.tracking.single_object.color.tolerance < 0 ||
    values.tracking.single_object.color.tolerance > 100
  ) {
    errors.push({
      field: "tracking.single_object.color.tolerance",
      code: "OUT_OF_RANGE",
      message: i18n.t("config.validation.colorToleranceRange"),
    });
  }
  const motionFeature = capabilities.ai?.features.find(
    (feature) => feature.id === "motion",
  );
  const motionCapability = capabilities.ai?.motion_detection;
  validateProcessingSize(
    "detection.motion.processing_size",
    values.detection.motion.processing_size,
    motionFeature
      ? featureProcessingSize(motionFeature)
      : typeof motionCapability === "object"
      ? motionCapability.processing_size ?? motionCapability.processingSize
      : capabilities.ai?.motion_processing_size ??
          capabilities.ai?.motionProcessingSize,
    errors,
  );
  const motionDetection = capabilities.ai?.motion_detection;
  const motionSupported =
    typeof motionDetection === "object"
      ? motionDetection.supported
      : motionDetection === true;
  if (
    motionSupported &&
    (!Number.isFinite(values.detection.motion.sensitivity) ||
      (values.detection.motion.sensitivity < 0 ||
        values.detection.motion.sensitivity > 100))
  ) {
    errors.push({
      field: "detection.motion.sensitivity",
      code: "OUT_OF_RANGE",
      message: i18n.t("config.validation.sensitivityRange"),
    });
  }

  const activeTpuFeatures = (capabilities.ai?.features ?? [])
    .map((feature) => feature.id)
    .filter(isTpuFeatureId)
    .filter((featureId) => tpuFeatureEnabled(values, featureId));
  if (
    activeTpuFeatures.length >
    (capabilities.ai?.max_active_tpu_features ?? 0)
  ) {
    errors.push({
      field: "detection",
      code: "AI_FEATURE_CONFLICT",
      message: i18n.t("config.validation.aiFeatureConflict"),
    });
  }
  return errors;
}

interface UseDeviceConfigurationOptions {
  apiBaseUrl: string;
  deviceId: string;
  onApplicationLockChange: (locked: boolean) => void;
  onDeviceRecovered: (apiBaseUrl: string, info: OvisDeviceInfo) => void;
}

interface VerificationResult {
  document: DeviceConfigDocument;
  capabilities: ConfigCapabilities;
  task: ConfigTask | null;
}

interface PendingValidatedApplication {
  payload: ConfigPayload;
  controller: AbortController;
  requiresReconnect: boolean;
  requiresDeviceReboot: boolean;
}

export function useDeviceConfiguration({
  apiBaseUrl,
  deviceId,
  onApplicationLockChange,
  onDeviceRecovered,
}: UseDeviceConfigurationOptions) {
  const pendingAtMount = useMemo(() => {
    const pending = readPendingConfigApplication();
    return pending?.device_id === deviceId ? pending : null;
  }, [deviceId]);
  const [status, setStatus] = useState<ConfigurationStatus>("loading");
  const [applicationState, setApplicationState] =
    useState<ConfigApplicationState>(
      pendingAtMount
        ? pendingAtMount.reconnect_required === false
          ? "verifying"
          : "reconnecting"
        : "idle",
    );
  const [capabilities, setCapabilities] = useState<ConfigCapabilities | null>(null);
  const [deviceRebootRequired, setDeviceRebootRequired] = useState(
    pendingAtMount?.reboot_required === true,
  );
  const [revision, setRevision] = useState<string | null>(null);
  const [targetRevision, setTargetRevision] = useState<string | null>(
    pendingAtMount?.target_revision ?? null,
  );
  const [original, setOriginal] = useState<DeviceConfigValues | null>(null);
  const [draft, setDraft] = useState<DeviceConfigValues | null>(null);
  const [validation, setValidation] =
    useState<ConfigValidationResponse | null>(null);
  const [task, setTask] = useState<ConfigTask | null>(null);
  const [outcome, setOutcome] = useState<ConfigurationOutcome | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [applicationConfirmation, setApplicationConfirmation] =
    useState<ConfigApplicationConfirmation | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const pendingValidatedApplication =
    useRef<PendingValidatedApplication | null>(null);

  const hasChanges = useMemo(
    () =>
      original !== null &&
      draft !== null &&
      JSON.stringify(original) !== JSON.stringify(draft),
    [draft, original],
  );

  const applicationBusy = [
    "validating",
    "confirming",
    "saving",
    "applying",
    "restart_pending",
    "reconnecting",
    "verifying",
  ].includes(applicationState);

  const beginOperation = useCallback(() => {
    operationController.current?.abort();
    const controller = new AbortController();
    operationController.current = controller;
    return controller;
  }, []);

  const assignDocument = useCallback((document: DeviceConfigDocument) => {
    const normalized = normalizeConfigValues(document.values);
    setRevision(document.revision);
    setOriginal(cloneValues(normalized));
    setDraft(normalizeOutputMode(normalized));
  }, []);

  const load = useCallback(async (overrideApiBaseUrl?: string) => {
    const requestApiBaseUrl = overrideApiBaseUrl ?? apiBaseUrl;
    const controller = beginOperation();
    setStatus("loading");
    setRequestError(null);
    setOutcome(null);
    setValidation(null);
    setTask(null);
    try {
      const [nextCapabilities, document] = await Promise.all([
        getConfigCapabilities(requestApiBaseUrl, controller.signal),
        getCurrentConfig(requestApiBaseUrl, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      assertCompleteConfigDocument(nextCapabilities, document);
      setCapabilities(nextCapabilities);
      assignDocument(document);
      setApplicationState("idle");
      setStatus("ready");
    } catch (error) {
      if (controller.signal.aborted) return;
      setRequestError(formatError(error));
      setStatus("error");
    }
  }, [apiBaseUrl, assignDocument, beginOperation]);

  const getTaskAllowMissing = useCallback(
    async (
      activeApiBaseUrl: string,
      taskId: number,
      signal: AbortSignal,
    ) => {
      try {
        return await getConfigTask(activeApiBaseUrl, taskId, signal);
      } catch (error) {
        if (error instanceof ConfigRequestError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    [],
  );

  const verifyRecoveredApplication = useCallback(
    async (
      pending: PendingConfigApplication,
      activeApiBaseUrl: string,
      controller: AbortController,
    ): Promise<VerificationResult> => {
      const deadline = pending.started_at + CONFIG_RECONNECT_TIMEOUT_MS;
      let nextCapabilities = capabilities;

      while (!controller.signal.aborted && Date.now() < deadline) {
        setApplicationState(pending.reboot_required ? "restart_pending" : "verifying");
        try {
          const [nextTask, document, loadedCapabilities] = await Promise.all([
            getTaskAllowMissing(
              activeApiBaseUrl,
              pending.task_id,
              controller.signal,
            ),
            getCurrentConfig(activeApiBaseUrl, controller.signal),
            nextCapabilities
              ? Promise.resolve(nextCapabilities)
              : getConfigCapabilities(activeApiBaseUrl, controller.signal),
          ]);
          nextCapabilities = loadedCapabilities;
          assertCompleteConfigDocument(loadedCapabilities, document);
          setTask(nextTask);

          if (nextTask?.state === "failed") {
            return { document, capabilities: loadedCapabilities, task: nextTask };
          }
          if (nextTask?.state === "succeeded" && !pending.reboot_required) {
            return { document, capabilities: loadedCapabilities, task: nextTask };
          }
          // The firmware reports success when it schedules the reboot, before
          // going offline. Its in-memory task disappears after Manager restarts.
          // Keep waiting even if the new revision is already readable, including
          // after a page refresh or when the browser missed the offline window.
          if (nextTask === null) {
            setApplicationState("verifying");
            return { document, capabilities: loadedCapabilities, task: nextTask };
          }
          await delay(
            Math.min(TASK_VERIFY_INTERVAL_MS, Math.max(0, deadline - Date.now())),
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) throw error;
          setApplicationState("reconnecting");
          const recovered = await reconnectConfigDevice(
            { ...pending, api_base_url: activeApiBaseUrl },
            controller.signal,
          );
          activeApiBaseUrl = recovered.apiBaseUrl;
          onDeviceRecovered(recovered.apiBaseUrl, recovered.info);
          writePendingConfigApplication({
            ...pending,
            api_base_url: recovered.apiBaseUrl,
          });
        }
      }

      throw new ConfigReconnectTimeoutError();
    },
    [capabilities, getTaskAllowMissing, onDeviceRecovered],
  );

  const finishRecoveredApplication = useCallback(
    (
      pending: PendingConfigApplication,
      result: VerificationResult,
    ) => {
      setCapabilities(result.capabilities);
      assignDocument(result.document);
      clearPendingConfigApplication();
      onApplicationLockChange(false);
      setStatus("ready");

      if (result.task?.state === "failed") {
        setApplicationState("failed");
        setOutcome({
          type: "error",
          message: result.task.message,
          rolledBack: result.task.rolled_back === true,
        });
        return;
      }
      if (result.document.revision === pending.target_revision) {
        setApplicationState("success");
        setOutcome({
          type: "success",
          message: i18n.t("config.validation.applySuccess"),
        });
        return;
      }
      setApplicationState("failed");
      setOutcome({
        type: "error",
        message: i18n.t("config.validation.rolledBack"),
        rolledBack: result.task?.rolled_back,
      });
    },
    [assignDocument, onApplicationLockChange],
  );

  const resumeApplication = useCallback(
    async (
      pending: PendingConfigApplication,
      controller: AbortController,
    ) => {
      onApplicationLockChange(true);
      setTargetRevision(pending.target_revision);
      setApplicationState("reconnecting");
      setRequestError(null);
      try {
        const recovered = await reconnectConfigDevice(pending, controller.signal);
        if (controller.signal.aborted) return;
        onDeviceRecovered(recovered.apiBaseUrl, recovered.info);
        const updatedPending = {
          ...pending,
          api_base_url: recovered.apiBaseUrl,
        };
        writePendingConfigApplication(updatedPending);
        const result = await verifyRecoveredApplication(
          updatedPending,
          recovered.apiBaseUrl,
          controller,
        );
        if (controller.signal.aborted) return;
        finishRecoveredApplication(updatedPending, result);
      } catch (error) {
        if (controller.signal.aborted) return;
        clearPendingConfigApplication();
        onApplicationLockChange(false);
        setApplicationState("failed");
        setRequestError(formatError(error));
        setOutcome({ type: "error", message: formatError(error) });
        setStatus(capabilities && draft ? "ready" : "error");
      }
    },
    [
      capabilities,
      draft,
      finishRecoveredApplication,
      onApplicationLockChange,
      onDeviceRecovered,
      verifyRecoveredApplication,
    ],
  );

  const resumeHotApplication = useCallback(
    async (
      pending: PendingConfigApplication,
      controller: AbortController,
    ) => {
      onApplicationLockChange(true);
      setTargetRevision(pending.target_revision);
      setApplicationState("verifying");
      setRequestError(null);
      try {
        const result = await verifyRecoveredApplication(
          pending,
          pending.api_base_url,
          controller,
        );
        if (!controller.signal.aborted) {
          finishRecoveredApplication(pending, result);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        clearPendingConfigApplication();
        onApplicationLockChange(false);
        setApplicationState("failed");
        setRequestError(formatError(error));
        setOutcome({ type: "error", message: formatError(error) });
        setStatus(capabilities && draft ? "ready" : "error");
      }
    },
    [
      capabilities,
      draft,
      finishRecoveredApplication,
      onApplicationLockChange,
      verifyRecoveredApplication,
    ],
  );

  useEffect(() => {
    if (pendingAtMount) {
      const controller = beginOperation();
      if (pendingAtMount.reconnect_required === false) {
        void resumeHotApplication(pendingAtMount, controller);
      } else {
        void resumeApplication(pendingAtMount, controller);
      }
    } else {
      void load();
    }
    return () => operationController.current?.abort();
    // Recovery updates its own callbacks and API address; only a device change restarts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  useEffect(() => {
    if (!hasChanges || applicationBusy) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [applicationBusy, hasChanges]);

  const updateDraft = useCallback(
    (mutator: (nextDraft: DeviceConfigValues) => void) => {
      if (applicationBusy) return;
      setDraft((current) => {
        if (!current) return current;
        const nextDraft = cloneValues(current);
        mutator(nextDraft);
        return nextDraft;
      });
      setValidation(null);
      setOutcome(null);
      setRequestError(null);
      if (applicationState === "success" || applicationState === "failed") {
        setApplicationState("idle");
      }
    },
    [applicationBusy, applicationState],
  );

  const finishApplicationError = useCallback(
    async (error: unknown, controller: AbortController) => {
      if (controller.signal.aborted) return;
      pendingValidatedApplication.current = null;
      setApplicationConfirmation(null);
      clearPendingConfigApplication();
      onApplicationLockChange(false);

      if (error instanceof ConfigRequestError && error.status === 409) {
        try {
          const [nextCapabilities, document] = await Promise.all([
            getConfigCapabilities(apiBaseUrl, controller.signal),
            getCurrentConfig(apiBaseUrl, controller.signal),
          ]);
          if (controller.signal.aborted) return;
          setCapabilities(nextCapabilities);
          assignDocument(document);
          setValidation(null);
          setRequestError(null);
          setStatus("ready");
          setApplicationState("failed");
          setOutcome({
            type: "error",
            message: i18n.t("config.validation.revisionConflict"),
          });
          return;
        } catch (reloadError) {
          if (controller.signal.aborted) return;
          setStatus("error");
          setApplicationState("failed");
          setRequestError(
            i18n.t("config.validation.revisionConflictReloadFailed", {
              message: formatError(reloadError),
            }),
          );
          return;
        }
      }

      setApplicationState("failed");
      setRequestError(formatError(error));
      setOutcome({ type: "error", message: formatError(error) });
    },
    [apiBaseUrl, assignDocument, onApplicationLockChange],
  );

  const persistValidatedApplication = useCallback(
    async ({ payload, controller, requiresReconnect, requiresDeviceReboot }: PendingValidatedApplication) => {
      pendingValidatedApplication.current = null;
      setApplicationConfirmation(null);
      setApplicationState("saving");
      setDeviceRebootRequired(requiresDeviceReboot);

      try {
        const saved = await saveConfig(apiBaseUrl, payload, controller.signal);
        if (!saved.saved) {
          throw new ConfigRequestError(i18n.t("config.validation.notSaved"));
        }
        setTargetRevision(saved.revision);

        setApplicationState("applying");
        const startedAt = Date.now();
        const taskReference = await applyConfig(
          apiBaseUrl,
          saved.revision,
          controller.signal,
        );
        const pending: PendingConfigApplication = {
          device_id: deviceId,
          api_base_url: apiBaseUrl,
          task_id: taskReference.task_id,
          target_revision: saved.revision,
          started_at: startedAt,
          reconnect_required: requiresReconnect,
          reboot_required: requiresDeviceReboot,
        };
        writePendingConfigApplication(pending);
        if (requiresReconnect) {
          setApplicationState("restart_pending");
          await delay(700, controller.signal);
          await resumeApplication(pending, controller);
        } else {
          setApplicationState("verifying");
          const result = await verifyRecoveredApplication(
            pending,
            apiBaseUrl,
            controller,
          );
          if (!controller.signal.aborted) {
            finishRecoveredApplication(pending, result);
          }
        }
      } catch (error) {
        await finishApplicationError(error, controller);
      }
    },
    [
      apiBaseUrl,
      deviceId,
      finishApplicationError,
      finishRecoveredApplication,
      resumeApplication,
      verifyRecoveredApplication,
    ],
  );

  const saveAndApply = useCallback(async (scope: ConfigSaveScope = "all") => {
    if (
      !capabilities ||
      !draft ||
      !original ||
      !revision ||
      !hasChanges ||
      applicationBusy
    ) {
      return;
    }
    const scopedValues = cloneValues(scope === "all" ? draft : original);
    if (scope === "detection") {
      scopedValues.detection.object = cloneValues(draft).detection.object;
    } else if (scope === "tracking") {
      scopedValues.tracking.single_object = cloneValues(draft).tracking.single_object;
    }
    const scopedHasChanges =
      JSON.stringify(serializeConfigValues(scopedValues, capabilities)) !==
      JSON.stringify(serializeConfigValues(original, capabilities));
    if (!scopedHasChanges) return;
    const localErrors = validateDraftLocally(capabilities, scopedValues);
    if (localErrors.length > 0) {
      setValidation({ valid: false, errors: localErrors, warnings: [], requires: [] });
      return;
    }

    const controller = beginOperation();
    const payload = {
      revision,
      values: serializeConfigValues(scopedValues, capabilities),
    };
    setApplicationState("validating");
    onApplicationLockChange(true);
    setRequestError(null);
    setOutcome(null);
    setTask(null);
    try {
      const validationResult = await validateConfig(
        apiBaseUrl,
        payload,
        controller.signal,
      );
      setValidation(validationResult);
      if (!validationResult.valid) {
        setApplicationState("idle");
        onApplicationLockChange(false);
        return;
      }

      const managementReconnect = validationResult.requires.includes(
        "management_reconnect",
      );
      const uvcChanged =
        capabilities.outputs?.uvc.supported === true &&
        original.outputs?.uvc.enabled !== scopedValues.outputs?.uvc.enabled;
      const requiresDeviceReboot =
        uvcChanged || validationResult.requires.includes("usb_gadget_restart");
      const requiresReconnect =
        managementReconnect ||
        requiresDeviceReboot ||
        validationResult.requires.includes("ipcamera_restart");
      const needsConfirmation =
        managementReconnect ||
        requiresDeviceReboot ||
        validationResult.warnings.length > 0;

      if (needsConfirmation) {
        pendingValidatedApplication.current = {
          payload,
          controller,
          requiresReconnect,
          requiresDeviceReboot,
        };
        setApplicationConfirmation({
          managementReconnect: managementReconnect || requiresDeviceReboot,
          deviceReboot: requiresDeviceReboot,
          warnings: validationResult.warnings,
        });
        setApplicationState("confirming");
        return;
      }

      await persistValidatedApplication({
        payload, controller, requiresReconnect, requiresDeviceReboot,
      });
    } catch (error) {
      await finishApplicationError(error, controller);
    }
  }, [
    apiBaseUrl,
    applicationBusy,
    beginOperation,
    capabilities,
    draft,
    finishApplicationError,
    hasChanges,
    onApplicationLockChange,
    original,
    persistValidatedApplication,
    revision,
  ]);

  const confirmApplication = useCallback(() => {
    const pending = pendingValidatedApplication.current;
    if (!pending) return;
    void persistValidatedApplication(pending);
  }, [persistValidatedApplication]);

  const cancelApplication = useCallback(() => {
    const pending = pendingValidatedApplication.current;
    pending?.controller.abort();
    pendingValidatedApplication.current = null;
    setApplicationConfirmation(null);
    setValidation(null);
    setApplicationState("idle");
    onApplicationLockChange(false);
  }, [onApplicationLockChange]);

  const pollResetTask = useCallback(
    async (taskId: number, controller: AbortController) => {
      for (let index = 0; index < MAX_RESET_TASK_POLLS; index += 1) {
        if (index > 0) await delay(TASK_VERIFY_INTERVAL_MS, controller.signal);
        const nextTask = await getConfigTask(apiBaseUrl, taskId, controller.signal);
        setTask(nextTask);
        if (
          nextTask.state === "failed" ||
          nextTask.state === "succeeded"
        ) {
          return nextTask;
        }
      }
      throw new ConfigRequestError(i18n.t("config.validation.resetTimeout"));
    },
    [apiBaseUrl],
  );

  const restoreDefaults = useCallback(async () => {
    if (applicationBusy) return;
    const controller = beginOperation();
    onApplicationLockChange(true);
    setStatus("resetting");
    setValidation(null);
    setOutcome(null);
    setRequestError(null);
    setTask(null);
    try {
      const taskReference = await resetConfig(apiBaseUrl, controller.signal);
      const completedTask = await pollResetTask(taskReference.task_id, controller);
      try {
        const document = await getCurrentConfig(apiBaseUrl, controller.signal);
        if (capabilities) assertCompleteConfigDocument(capabilities, document);
        assignDocument(document);
      } catch (error) {
        if (controller.signal.aborted) return;
        setRequestError(
          i18n.t("config.validation.afterReset", {
            message: formatError(error),
          }),
        );
      }
      setStatus("ready");
      onApplicationLockChange(false);
      if (completedTask.state === "failed") {
        setOutcome({
          type: "error",
          message: completedTask.message,
          rolledBack: completedTask.rolled_back === true,
        });
        return;
      }
      setOutcome({
        type: "success",
        message:
          completedTask.message || i18n.t("config.validation.resetSuccess"),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      onApplicationLockChange(false);
      setRequestError(formatError(error));
      setStatus("ready");
    }
  }, [
    apiBaseUrl,
    applicationBusy,
    assignDocument,
    beginOperation,
    capabilities,
    onApplicationLockChange,
    pollResetTask,
  ]);

  const dismissOutcome = useCallback(() => {
    setOutcome(null);
    if (applicationState === "success" || applicationState === "failed") {
      setApplicationState("idle");
    }
  }, [applicationState]);

  return {
    status,
    applicationState,
    applicationBusy,
    capabilities,
    revision,
    deviceRebootRequired,
    targetRevision,
    original,
    draft,
    validation,
    task,
    outcome,
    requestError,
    applicationConfirmation,
    hasChanges,
    load,
    updateDraft,
    saveAndApply,
    confirmApplication,
    cancelApplication,
    restoreDefaults,
    dismissOutcome,
  };
}
