import i18n from "./i18n";

interface RuntimeTaskMessage {
  state?: string;
  stage?: string;
  message?: string | null;
}

const CJK_TEXT = /[\u3400-\u9fff]/;

const modelTaskAliases: Record<string, string> = {
  object_detection: "object_detection",
  "目标检测": "object_detection",
  image_classification: "image_classification",
  "图像分类": "image_classification",
  keypoint_detection: "keypoint_detection",
  "关键点检测": "keypoint_detection",
  instance_segmentation: "instance_segmentation",
  "实例分割": "instance_segmentation",
  image_feature: "image_feature",
  "图像特征提取": "image_feature",
  sound_classification: "sound_classification",
  "语音命令分类": "sound_classification",
};

export function localizedRuntimeText(
  message: string | null | undefined,
  fallback: string,
  language: string,
) {
  const value = message?.trim();
  if (!value) return fallback;
  if (!language.toLowerCase().startsWith("zh") && CJK_TEXT.test(value)) {
    return fallback;
  }
  return value;
}

export function localizedTaskMessage(
  task: RuntimeTaskMessage | null | undefined,
  language: string,
) {
  const stageFallback = (() => {
    switch (task?.stage) {
      case "queued": return i18n.t("runtimeTasks.stages.queued");
      case "controlling_ipcamera": return i18n.t("runtimeTasks.stages.controllingIpCamera");
      case "restarting_ipcamera": return i18n.t("runtimeTasks.stages.restartingIpCamera");
      case "restoring_defaults": return i18n.t("runtimeTasks.stages.restoringDefaults");
      case "completed": return i18n.t("runtimeTasks.stages.completed");
      case "failed": return i18n.t("runtimeTasks.stages.failed");
      default: return null;
    }
  })();
  const fallback = stageFallback ?? (() => {
    switch (task?.state) {
      case "queued": return i18n.t("runtimeTasks.states.queued");
      case "succeeded": return i18n.t("runtimeTasks.states.succeeded");
      case "failed": return i18n.t("runtimeTasks.states.failed");
      default: return i18n.t("runtimeTasks.states.running");
    }
  })();

  if (task?.state === "failed" || task?.state === "succeeded") {
    return localizedRuntimeText(task.message, fallback, language);
  }
  return fallback;
}

export function localizedImporterName(
  importerId: string,
  fallbackName: string,
  language: string,
) {
  switch (importerId) {
    case "detection.yolov5": return i18n.t("models.importers.detection.yolov5");
    case "detection.yolov6": return i18n.t("models.importers.detection.yolov6");
    case "detection.yolov7": return i18n.t("models.importers.detection.yolov7");
    case "detection.yolov8": return i18n.t("models.importers.detection.yolov8");
    case "detection.yolov10": return i18n.t("models.importers.detection.yolov10");
    case "detection.yolo26": return i18n.t("models.importers.detection.yolo26");
    case "detection.ppyoloe": return i18n.t("models.importers.detection.ppyoloe");
    case "detection.yolox": return i18n.t("models.importers.detection.yolox");
    case "classification.image": return i18n.t("models.importers.classification.image");
    case "classification.sound_command": return i18n.t("models.importers.classification.sound_command");
    case "pose.yolov8": return i18n.t("models.importers.pose.yolov8");
    case "segmentation.yolov8": return i18n.t("models.importers.segmentation.yolov8");
    case "feature.image": return i18n.t("models.importers.feature.image");
    default:
      return localizedRuntimeText(
        fallbackName,
        i18n.t("models.unknownImporter"),
        language,
      );
  }
}

export function localizedModelTask(
  task: string,
  language: string,
) {
  const normalizedTask = modelTaskAliases[task];
  switch (normalizedTask) {
    case "object_detection": return i18n.t("models.tasks.object_detection");
    case "image_classification": return i18n.t("models.tasks.image_classification");
    case "keypoint_detection": return i18n.t("models.tasks.keypoint_detection");
    case "instance_segmentation": return i18n.t("models.tasks.instance_segmentation");
    case "image_feature": return i18n.t("models.tasks.image_feature");
    case "sound_classification": return i18n.t("models.tasks.sound_classification");
    default: return localizedRuntimeText(task, i18n.t("models.unknownTask"), language);
  }
}

export function localizedModelStatus(
  status: string,
  language: string,
) {
  switch (status) {
    case "created": return i18n.t("models.statuses.created");
    case "uploaded": return i18n.t("models.statuses.uploaded");
    case "ready": return i18n.t("models.statuses.ready");
    case "failed": return i18n.t("models.statuses.failed");
    default: return localizedRuntimeText(status, i18n.t("models.unknownStatus"), language);
  }
}
