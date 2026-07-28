/* eslint-disable react-refresh/only-export-components */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { localizedImporterName } from "../../i18n.runtime";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import type {
  ImportFormSubmission,
  ImportMetadata,
  ModelImporter,
  ModelImporterId,
  RuntimeJsonSchema,
} from "./model.types";

interface ImporterFormProps {
  importer: ModelImporter;
  availableBytes: number;
  disabled?: boolean;
  onSubmit: (submission: ImportFormSubmission) => void;
  onCancel: () => void;
}

export interface SupportedImporterDefinition {
  id: ModelImporterId;
  component: React.ComponentType<ImporterFormProps>;
}

const schemaOf = (value: unknown): RuntimeJsonSchema =>
  typeof value === "object" && value !== null
    ? (value as RuntimeJsonSchema)
    : {};

const metadataProperty = (importer: ModelImporter, name: string) =>
  schemaOf(importer.metadataSchema).properties?.[name] ?? {};

const importerDefault = <T,>(
  importer: ModelImporter,
  name: string,
  fallback: T,
): T => {
  const defaults = importer.defaults;
  if (defaults && name in defaults) return defaults[name] as T;
  const propertyDefault = metadataProperty(importer, name).default;
  return propertyDefault === undefined ? fallback : (propertyDefault as T);
};

const trimmedValues = (values: string[]) =>
  values.map((value) => value.trim());

function validateValue(
  path: string,
  value: unknown,
  schema: RuntimeJsonSchema,
  errors: string[],
) {
  schema.allOf?.forEach((entry) => validateValue(path, value, entry, errors));
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    errors.push(`${path}: unsupported value`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: minimum length ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: maximum length ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: invalid format`);
    }
  }
  if (typeof value === "number") {
    if (schema.type === "integer" && !Number.isInteger(value)) {
      errors.push(`${path}: integer required`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: minimum ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: maximum ${schema.maxItems}`);
    }
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      errors.push(`${path}: values must be unique`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateValue(`${path}[${index}]`, item, schema.items ?? {}, errors),
      );
    }
  }
}

function validateMetadata(
  importer: ModelImporter,
  metadata: Record<string, unknown>,
): string[] {
  const schema = schemaOf(importer.metadataSchema);
  const constraints = schemaOf(importer.constraints);
  const constraintProperties = (constraints.properties ?? constraints) as Record<
    string,
    RuntimeJsonSchema
  >;
  const errors: string[] = [];
  (schema.required ?? []).forEach((field) => {
    const value = metadata[field];
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      errors.push(`${field}: required`);
    }
  });
  Object.entries(metadata).forEach(([field, value]) => {
    validateValue(field, value, schema.properties?.[field] ?? {}, errors);
    validateValue(field, value, constraintProperties[field] ?? {}, errors);
  });
  const std = metadata.std;
  if (Array.isArray(std) && std.some((value) => Number(value) === 0)) {
    errors.push("std: values cannot be zero");
  }
  const labels = metadata.labels;
  const colors = metadata.colors;
  if (Array.isArray(colors) && Array.isArray(labels) && colors.length !== labels.length) {
    errors.push("colors: one color is required for each label");
  }
  const keypoints = metadata.keypoints;
  const skeleton = metadata.skeleton;
  if (Array.isArray(keypoints) && Array.isArray(skeleton)) {
    skeleton.forEach((edge, index) => {
      if (
        !Array.isArray(edge) ||
        edge.length !== 2 ||
        edge[0] === edge[1] ||
        edge.some(
          (point) =>
            !Number.isInteger(point) ||
            Number(point) < 0 ||
            Number(point) >= keypoints.length,
        )
      ) {
        errors.push(`skeleton[${index}]: invalid keypoint reference`);
      }
    });
  }
  return errors;
}

interface OrderedListProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  colors?: string[];
  onColors?: (colors: string[]) => void;
}

function OrderedList({ label, values, onChange, colors, onColors }: OrderedListProps) {
  const { t } = useTranslation();
  const update = (index: number, value: string) => {
    const next = [...values];
    next[index] = value;
    onChange(next);
  };
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    if (colors && onColors) {
      const nextColors = [...colors];
      [nextColors[index], nextColors[target]] = [nextColors[target], nextColors[index]];
      onColors(nextColors);
    }
  };
  const remove = (index: number) => {
    onChange(values.filter((_, itemIndex) => itemIndex !== index));
    if (colors && onColors) onColors(colors.filter((_, itemIndex) => itemIndex !== index));
  };
  const add = () => {
    onChange([...values, ""]);
    if (colors && onColors) onColors([...colors, "#A8D64E"]);
  };
  return (
    <div className="model-list-editor">
      <div className="model-field-heading">
        <label>{label}</label>
        <output>{values.length}</output>
      </div>
      {values.map((value, index) => (
        <div className="model-list-editor__row" key={index}>
          <span>{String(index).padStart(2, "0")}</span>
          <input
            value={value}
            aria-label={`${label} ${index + 1}`}
            onChange={(event) => update(index, event.target.value)}
          />
          {colors && onColors && (
            <input
              type="color"
              value={colors[index] ?? "#A8D64E"}
              aria-label={`${label} ${index + 1} color`}
              onChange={(event) => {
                const next = [...colors];
                next[index] = event.target.value.toUpperCase();
                onColors(next);
              }}
            />
          )}
          <button type="button" className="icon-button" title={t("models.moveUp")} onClick={() => move(index, -1)}>
            <ArrowUp size={14} />
          </button>
          <button type="button" className="icon-button" title={t("models.moveDown")} onClick={() => move(index, 1)}>
            <ArrowDown size={14} />
          </button>
          <button type="button" className="icon-button" title={t("common.delete")} onClick={() => remove(index)}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="button button--ghost model-add-row" onClick={add}>
        <Plus size={14} /> {t("models.addItem")}
      </button>
    </div>
  );
}

function Vector3Editor({
  label,
  values,
  onChange,
}: {
  label: string;
  values: number[];
  onChange: (values: number[]) => void;
}) {
  return (
    <label className="model-vector-field">
      <span>{label}</span>
      <span>
        {[0, 1, 2].map((index) => (
          <input
            key={index}
            type="number"
            step="0.001"
            value={values[index] ?? 0}
            aria-label={`${label} ${index + 1}`}
            onChange={(event) => {
              const next = [...values];
              next[index] = Number(event.target.value);
              onChange(next);
            }}
          />
        ))}
      </span>
    </label>
  );
}

function AnchorEditor({
  importer,
  anchors,
  onChange,
}: {
  importer: ModelImporter;
  anchors: number[][][];
  onChange: (anchors: number[][][]) => void;
}) {
  const { t } = useTranslation();
  const defaults = importerDefault<number[][][]>(importer, "anchors", anchors);
  return (
    <div className="anchor-editor">
      <div className="model-field-heading">
        <label>{t("models.fields.anchors")}</label>
        <button type="button" className="button button--ghost" onClick={() => onChange(structuredClone(defaults))}>
          <RotateCcw size={13} /> {t("models.restoreAnchors")}
        </button>
      </div>
      {anchors.map((group, groupIndex) => (
        <div className="anchor-editor__group" key={groupIndex}>
          <span>HEAD {groupIndex + 1}</span>
          {group.map((pair, pairIndex) => (
            <span key={pairIndex}>
              {[0, 1].map((axis) => (
                <input
                  key={axis}
                  type="number"
                  min="1"
                  max="65535"
                  value={pair[axis] ?? 1}
                  aria-label={`Anchor ${groupIndex + 1}-${pairIndex + 1}-${axis === 0 ? "width" : "height"}`}
                  onChange={(event) => {
                    const next = structuredClone(anchors);
                    next[groupIndex][pairIndex][axis] = Number(event.target.value);
                    onChange(next);
                  }}
                />
              ))}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

interface ImportFrameProps {
  importer: ModelImporter;
  availableBytes: number;
  name: string;
  file: File | null;
  errors: string[];
  disabled: boolean;
  onName: (value: string) => void;
  onFile: (file: File | null) => void;
  onSubmit: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

function ImportFrame({
  importer,
  availableBytes,
  name,
  file,
  errors,
  disabled,
  onName,
  onFile,
  onSubmit,
  onCancel,
  children,
}: ImportFrameProps) {
  const { t, i18n } = useTranslation();
  return (
    <form
      className="model-import-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <header>
        <div>
          <span>{importer.id}</span>
          <h4>{localizedImporterName(importer.id, importer.name, i18n.language)}</h4>
        </div>
        <small>{t("models.maxFile", { size: formatBytes(Math.min(importer.maxFileSize, availableBytes)) })}</small>
      </header>
      <fieldset disabled={disabled}>
      <div className="model-import-form__common">
        <label>
          <span>{t("models.fields.name")}</span>
          <input value={name} maxLength={64} onChange={(event) => onName(event.target.value)} />
        </label>
        <label>
          <span>{t("models.fields.bmodel")}</span>
          <input
            type="file"
            accept=".bmodel,application/octet-stream"
            onChange={(event) => onFile(event.target.files?.[0] ?? null)}
          />
          <small>{file ? `${file.name} · ${formatBytes(file.size)}` : t("models.noFile")}</small>
        </label>
      </div>
      {children}
      {errors.length > 0 && (
        <div className="model-form-errors" role="alert">
          {errors.map((error) => <span key={error}>{error}</span>)}
        </div>
      )}
      <footer>
        <button type="button" className="button button--ghost" onClick={onCancel}>{t("common.cancel")}</button>
        <button type="submit" className="button button--primary"><Upload size={15} />{t("models.createAndUpload")}</button>
      </footer>
      </fieldset>
    </form>
  );
}

const formatBytes = (bytes: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024) + " MB";

function useImportSubmission(
  importer: ModelImporter,
  availableBytes: number,
  metadata: Record<string, unknown>,
  onSubmit: ImporterFormProps["onSubmit"],
) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const submit = () => {
    const nextErrors = validateMetadata(importer, metadata);
    if (!name.trim()) nextErrors.unshift("name: required");
    if (!file) nextErrors.unshift("BModel: required");
    if (file && file.size > importer.maxFileSize) nextErrors.unshift("BModel: file exceeds importer limit");
    if (file && file.size > availableBytes) nextErrors.unshift("BModel: insufficient device storage");
    setErrors(nextErrors);
    if (!file || nextErrors.length > 0) return;
    onSubmit({
      importer,
      name: name.trim(),
      file,
      metadata: metadata as ImportMetadata,
    });
  };
  return { name, setName, file, setFile, errors, submit };
}

function DetectionImportForm(props: ImporterFormProps & { anchored: boolean }) {
  const { t } = useTranslation();
  const [labels, setLabels] = useState<string[]>(
    importerDefault(props.importer, "labels", [""]),
  );
  const [anchors, setAnchors] = useState<number[][][]>(() =>
    structuredClone(importerDefault(props.importer, "anchors", [
      [[10, 13], [16, 30], [33, 23]],
      [[30, 61], [62, 45], [59, 119]],
      [[116, 90], [156, 198], [373, 326]],
    ])),
  );
  const metadata = useMemo(
    () => ({ labels: trimmedValues(labels), ...(props.anchored ? { anchors } : {}) }),
    [anchors, labels, props.anchored],
  );
  const form = useImportSubmission(props.importer, props.availableBytes, metadata, props.onSubmit);
  return (
    <ImportFrame importer={props.importer} availableBytes={props.availableBytes} name={form.name} file={form.file} errors={form.errors} disabled={props.disabled ?? false} onName={form.setName} onFile={form.setFile} onSubmit={form.submit} onCancel={props.onCancel}>
      <OrderedList label={t("models.fields.classes")} values={labels} onChange={setLabels} />
      {props.anchored && <AnchorEditor importer={props.importer} anchors={anchors} onChange={setAnchors} />}
    </ImportFrame>
  );
}

const YoloV5ImportForm = (props: ImporterFormProps) => <DetectionImportForm {...props} anchored />;
const YoloV6ImportForm = (props: ImporterFormProps) => <DetectionImportForm {...props} anchored={false} />;
const YoloV7ImportForm = (props: ImporterFormProps) => <DetectionImportForm {...props} anchored />;
const YoloV8ImportForm = (props: ImporterFormProps) => <DetectionImportForm {...props} anchored={false} />;
const YoloV10ImportForm = (props: ImporterFormProps) => <DetectionImportForm {...props} anchored={false} />;
const Yolo26ImportForm = (props: ImporterFormProps) => <DetectionImportForm {...props} anchored={false} />;
const PpYoloEImportForm = (props: ImporterFormProps) => <DetectionImportForm {...props} anchored={false} />;
const YoloXImportForm = (props: ImporterFormProps) => <DetectionImportForm {...props} anchored={false} />;

function ClassificationImportForm(props: ImporterFormProps) {
  const { t } = useTranslation();
  const [labels, setLabels] = useState<string[]>(
    importerDefault(props.importer, "labels", ["", ""]),
  );
  const [rgbOrder, setRgbOrder] = useState<"RGB" | "BGR">(importerDefault(props.importer, "rgbOrder", "RGB"));
  const [mean, setMean] = useState<number[]>(importerDefault(props.importer, "mean", [0, 0, 0]));
  const [std, setStd] = useState<number[]>(importerDefault(props.importer, "std", [1, 1, 1]));
  const metadata = useMemo(() => ({ labels: trimmedValues(labels), rgbOrder, mean, std }), [labels, mean, rgbOrder, std]);
  const form = useImportSubmission(props.importer, props.availableBytes, metadata, props.onSubmit);
  return <ImportFrame importer={props.importer} availableBytes={props.availableBytes} name={form.name} file={form.file} errors={form.errors} disabled={props.disabled ?? false} onName={form.setName} onFile={form.setFile} onSubmit={form.submit} onCancel={props.onCancel}>
    <OrderedList label={t("models.fields.classes")} values={labels} onChange={setLabels} />
    <RgbOrder value={rgbOrder} onChange={setRgbOrder} />
    <Vector3Editor label="Mean" values={mean} onChange={setMean} />
    <Vector3Editor label="Std" values={std} onChange={setStd} />
  </ImportFrame>;
}

function RgbOrder({ value, onChange }: { value: "RGB" | "BGR"; onChange: (value: "RGB" | "BGR") => void }) {
  const { t } = useTranslation();
  return <label className="model-select-field"><span>{t("models.fields.channelOrder")}</span><select value={value} onChange={(event) => onChange(event.target.value as "RGB" | "BGR")}><option value="RGB">RGB</option><option value="BGR">BGR</option></select></label>;
}

function PoseImportForm(props: ImporterFormProps) {
  const { t } = useTranslation();
  const [labels, setLabels] = useState<string[]>(
    importerDefault(props.importer, "labels", [""]),
  );
  const [keypoints, setKeypoints] = useState<string[]>(
    importerDefault(props.importer, "keypoints", [""]),
  );
  const [rgbOrder, setRgbOrder] = useState<"RGB" | "BGR">(importerDefault(props.importer, "rgbOrder", "RGB"));
  const [skeleton, setSkeleton] = useState<number[][]>(
    importerDefault(props.importer, "skeleton", []),
  );
  const metadata = useMemo(() => ({ labels: trimmedValues(labels), keypoints: trimmedValues(keypoints), rgbOrder, skeleton }), [keypoints, labels, rgbOrder, skeleton]);
  const form = useImportSubmission(props.importer, props.availableBytes, metadata, props.onSubmit);
  return <ImportFrame importer={props.importer} availableBytes={props.availableBytes} name={form.name} file={form.file} errors={form.errors} disabled={props.disabled ?? false} onName={form.setName} onFile={form.setFile} onSubmit={form.submit} onCancel={props.onCancel}>
    <OrderedList label={t("models.fields.classes")} values={labels} onChange={setLabels} />
    <OrderedList label={t("models.fields.keypoints")} values={keypoints} onChange={setKeypoints} />
    <RgbOrder value={rgbOrder} onChange={setRgbOrder} />
    <SkeletonEditor keypoints={keypoints} skeleton={skeleton} onChange={setSkeleton} />
  </ImportFrame>;
}

function SkeletonEditor({ keypoints, skeleton, onChange }: { keypoints: string[]; skeleton: number[][]; onChange: (value: number[][]) => void }) {
  const { t } = useTranslation();
  return <div className="skeleton-editor"><div className="model-field-heading"><label>{t("models.fields.skeleton")}</label><button type="button" className="button button--ghost" onClick={() => onChange([...skeleton, [0, Math.min(1, keypoints.length - 1)]])}><Plus size={13} />{t("models.addConnection")}</button></div>{skeleton.map((edge, index) => <div key={index}><select value={edge[0]} onChange={(event) => { const next = structuredClone(skeleton); next[index][0] = Number(event.target.value); onChange(next); }}>{keypoints.map((point, pointIndex) => <option key={pointIndex} value={pointIndex}>{point || `#${pointIndex}`}</option>)}</select><span>→</span><select value={edge[1]} onChange={(event) => { const next = structuredClone(skeleton); next[index][1] = Number(event.target.value); onChange(next); }}>{keypoints.map((point, pointIndex) => <option key={pointIndex} value={pointIndex}>{point || `#${pointIndex}`}</option>)}</select><button type="button" className="icon-button" onClick={() => onChange(skeleton.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={14} /></button></div>)}</div>;
}

function SegmentationImportForm(props: ImporterFormProps) {
  const { t } = useTranslation();
  const [labels, setLabels] = useState<string[]>(
    importerDefault(props.importer, "labels", [""]),
  );
  const [colors, setColors] = useState<string[]>(
    importerDefault(props.importer, "colors", ["#A8D64E"]),
  );
  const [rgbOrder, setRgbOrder] = useState<"RGB" | "BGR">(importerDefault(props.importer, "rgbOrder", "RGB"));
  const metadata = useMemo(() => ({ labels: trimmedValues(labels), rgbOrder, colors: colors.slice(0, labels.length) }), [colors, labels, rgbOrder]);
  const form = useImportSubmission(props.importer, props.availableBytes, metadata, props.onSubmit);
  return <ImportFrame importer={props.importer} availableBytes={props.availableBytes} name={form.name} file={form.file} errors={form.errors} disabled={props.disabled ?? false} onName={form.setName} onFile={form.setFile} onSubmit={form.submit} onCancel={props.onCancel}><OrderedList label={t("models.fields.classes")} values={labels} onChange={setLabels} colors={colors} onColors={setColors} /><RgbOrder value={rgbOrder} onChange={setRgbOrder} /></ImportFrame>;
}

function FeatureImportForm(props: ImporterFormProps) {
  const [rgbOrder, setRgbOrder] = useState<"RGB" | "BGR">(importerDefault(props.importer, "rgbOrder", "RGB"));
  const [mean, setMean] = useState<number[]>(importerDefault(props.importer, "mean", [0, 0, 0]));
  const [std, setStd] = useState<number[]>(importerDefault(props.importer, "std", [1, 1, 1]));
  const metadata = useMemo(() => ({ rgbOrder, mean, std }), [mean, rgbOrder, std]);
  const form = useImportSubmission(props.importer, props.availableBytes, metadata, props.onSubmit);
  return <ImportFrame importer={props.importer} availableBytes={props.availableBytes} name={form.name} file={form.file} errors={form.errors} disabled={props.disabled ?? false} onName={form.setName} onFile={form.setFile} onSubmit={form.submit} onCancel={props.onCancel}><RgbOrder value={rgbOrder} onChange={setRgbOrder} /><Vector3Editor label="Mean" values={mean} onChange={setMean} /><Vector3Editor label="Std" values={std} onChange={setStd} /></ImportFrame>;
}

function SoundCommandImportForm(props: ImporterFormProps) {
  const { t } = useTranslation();
  const [labels, setLabels] = useState<string[]>(
    importerDefault(props.importer, "labels", ["", ""]),
  );
  const sampleOptions = metadataProperty(props.importer, "sampleRate").enum?.map(Number) ?? [8000, 16000];
  const preprocessOptions = metadataProperty(props.importer, "preprocessProfile").enum?.map(String) ?? [];
  const [sampleRate, setSampleRate] = useState(importerDefault(props.importer, "sampleRate", Number(sampleOptions[0] ?? 16000)));
  const [channels] = useState(importerDefault(props.importer, "channels", 1));
  const [hopLength, setHopLength] = useState(importerDefault(props.importer, "hopLength", 128));
  const [preprocessProfile, setPreprocessProfile] = useState(importerDefault(props.importer, "preprocessProfile", preprocessOptions[0] ?? ""));
  const metadata = useMemo(() => ({ labels: trimmedValues(labels), sampleRate, channels, hopLength, preprocessProfile }), [channels, hopLength, labels, preprocessProfile, sampleRate]);
  const form = useImportSubmission(props.importer, props.availableBytes, metadata, props.onSubmit);
  return <ImportFrame importer={props.importer} availableBytes={props.availableBytes} name={form.name} file={form.file} errors={form.errors} disabled={props.disabled ?? false} onName={form.setName} onFile={form.setFile} onSubmit={form.submit} onCancel={props.onCancel}><OrderedList label={t("models.fields.commands")} values={labels} onChange={setLabels} /><label className="model-select-field"><span>{t("models.fields.sampleRate")}</span><select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))}>{sampleOptions.map((option) => <option key={option} value={option}>{option} Hz</option>)}</select></label><label className="model-number-field"><span>{t("models.fields.channels")}</span><input type="number" value={channels} disabled /></label><label className="model-number-field"><span>Hop Length</span><input type="number" min={metadataProperty(props.importer, "hopLength").minimum} max={metadataProperty(props.importer, "hopLength").maximum} value={hopLength} onChange={(event) => setHopLength(Number(event.target.value))} /></label><label className="model-select-field"><span>{t("models.fields.preprocess")}</span><select value={preprocessProfile} onChange={(event) => setPreprocessProfile(event.target.value)}>{preprocessOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label></ImportFrame>;
}

export const SUPPORTED_IMPORTERS: SupportedImporterDefinition[] = [
  { id: "detection.yolov5", component: YoloV5ImportForm },
  { id: "detection.yolov6", component: YoloV6ImportForm },
  { id: "detection.yolov7", component: YoloV7ImportForm },
  { id: "detection.yolov8", component: YoloV8ImportForm },
  { id: "detection.yolov10", component: YoloV10ImportForm },
  { id: "detection.yolo26", component: Yolo26ImportForm },
  { id: "detection.ppyoloe", component: PpYoloEImportForm },
  { id: "detection.yolox", component: YoloXImportForm },
  { id: "classification.image", component: ClassificationImportForm },
  { id: "pose.yolov8", component: PoseImportForm },
  { id: "segmentation.yolov8", component: SegmentationImportForm },
  { id: "feature.image", component: FeatureImportForm },
  { id: "classification.sound_command", component: SoundCommandImportForm },
];

export const supportedImporter = (importer: ModelImporter) =>
  importer.schemaVersion === 1 &&
  importer.enabled &&
  SUPPORTED_IMPORTERS.find((definition) => definition.id === importer.id);
