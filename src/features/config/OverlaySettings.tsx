import type { CSSProperties, ReactNode } from "react";
import { Crosshair, ScanLine, Type } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  OverlayCapabilities,
  OverlayConfigValues,
  OverlayLabelMode,
  OverlayTextPosition,
  ReticleTemplate,
} from "./config.types";

interface OverlaySettingsProps {
  capability?: OverlayCapabilities;
  values: OverlayConfigValues;
  disabled: boolean;
  videoWidth: number;
  videoHeight: number;
  onChange: (mutator: (overlay: OverlayConfigValues) => void) => void;
}

interface ColorFieldProps {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function ColorField({ label, value, disabled, onChange }: ColorFieldProps) {
  const safeValue = COLOR_PATTERN.test(value) ? value : "#FFFFFF";
  return (
    <label className="overlay-color-field">
      <span>{label}</span>
      <span className="overlay-color-field__control">
        <input
          type="color"
          value={safeValue}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
        <output>{value.toUpperCase()}</output>
      </span>
    </label>
  );
}

interface ThicknessFieldProps {
  label: string;
  value: number;
  capability: OverlayCapabilities["thickness"];
  disabled: boolean;
  onChange: (value: number) => void;
}

function ThicknessField({
  label,
  value,
  capability,
  disabled,
  onChange,
}: ThicknessFieldProps) {
  return (
    <label className="overlay-range-field">
      <span>{label}</span>
      <input
        type="range"
        min={capability.min}
        max={capability.max}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value}px</output>
    </label>
  );
}

function TrackingCorners() {
  return (
    <svg className="overlay-preview__corners" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path d="M 1 25 V 1 H 25 M 75 1 H 99 V 25 M 99 75 V 99 H 75 M 25 99 H 1 V 75"
        fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ReticleShape({ template }: { template: ReticleTemplate }) {
  return (
    <span className={`overlay-reticle overlay-reticle--${template}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <b />
    </span>
  );
}

const previewTextPosition = (
  position: OverlayTextPosition,
  x: number,
  y: number,
  width: number,
  height: number,
): CSSProperties => {
  if (position !== "custom") return {};
  return {
    left: `${Math.min(100, Math.max(0, (x / Math.max(1, width)) * 100))}%`,
    top: `${Math.min(100, Math.max(0, (y / Math.max(1, height)) * 100))}%`,
  };
};

interface OverlayPreviewProps {
  values: OverlayConfigValues;
  targetReady: boolean;
  width: number;
  height: number;
}

function OverlayPreview({
  values,
  targetReady,
  width,
  height,
}: OverlayPreviewProps) {
  const { t } = useTranslation();
  const text = values.texts[0];
  const label =
    values.detection.labelMode === "class_score"
      ? t("config.overlay.preview.personScore")
      : values.detection.labelMode === "class"
        ? t("config.overlay.preview.person")
        : "";
  const previewStyle = {
    "--det-color": values.detection.color,
    "--det-width": `${values.detection.thickness}px`,
    "--track-color": values.tracking.color,
    "--track-lost-color": values.tracking.lostColor,
    "--track-width": `${values.tracking.thickness}px`,
    "--reticle-color": targetReady
      ? values.reticle.readyColor
      : values.reticle.idleColor,
    "--reticle-width": `${values.reticle.thickness}px`,
  } as CSSProperties;

  return (
    <div
      className={`overlay-preview ${values.enabled ? "" : "overlay-preview--disabled"}`}
      style={previewStyle}
      aria-label={t("config.overlay.preview.title")}
    >
      <div className="overlay-preview__scene" aria-hidden="true">
        <span className="overlay-preview__horizon" />
        {values.enabled && text?.enabled && text.content && (
          <span
            className={`overlay-preview__text overlay-preview__text--${text.position}`}
            style={{
              color: text.color,
              ...previewTextPosition(text.position, text.x, text.y, width, height),
            }}
          >
            {text.content}
          </span>
        )}
        {values.enabled && values.detection.enabled && (
          <>
            <span
              className={`overlay-preview__detection ${values.detection.colorMode === "model" ? "overlay-preview__detection--model" : ""}`}
            >
              {label && <em>{label}</em>}
            </span>
            <span className="overlay-preview__detection overlay-preview__detection--secondary" />
          </>
        )}
        {values.enabled && values.tracking.enabled && (
          <>
            <span className={`overlay-preview__tracking ${values.tracking.boxStyle === "corners" ? "overlay-preview__box--corners" : ""}`}>
              {values.tracking.boxStyle === "corners" && <TrackingCorners />}
              <em>{t("config.overlay.preview.tracking")}</em>
            </span>
            {!values.tracking.hideWhenLost && (
              <span className={`overlay-preview__tracking-lost ${values.tracking.boxStyle === "corners" ? "overlay-preview__box--corners" : ""}`}>
                {values.tracking.boxStyle === "corners" && <TrackingCorners />}
              </span>
            )}
          </>
        )}
        {values.enabled && values.reticle.enabled && (
          <ReticleShape template={values.reticle.template} />
        )}
        {!values.enabled && (
          <span className="overlay-preview__off">{t("config.overlay.preview.disabled")}</span>
        )}
      </div>
    </div>
  );
}

interface SettingGroupProps {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}

function SettingGroup({ icon, title, description, children }: SettingGroupProps) {
  return (
    <section className="overlay-settings__group">
      <header>
        <span>{icon}</span>
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
      </header>
      <div className="overlay-settings__controls">{children}</div>
    </section>
  );
}

export function OverlaySettings({
  capability,
  values,
  disabled,
  videoWidth,
  videoHeight,
  onChange,
}: OverlaySettingsProps) {
  const { t } = useTranslation();
  const [targetReady, setTargetReady] = useState(false);
  const text = values.texts[0];
  const updateText = (mutator: (entry: OverlayConfigValues["texts"][number]) => void) =>
    onChange((overlay) => {
      if (!overlay.texts[0]) return;
      mutator(overlay.texts[0]);
    });
  const byteLength = new TextEncoder().encode(text?.content ?? "").length;

  return (
    <div className="overlay-settings">
      <div className="overlay-settings__preview-column">
        <OverlayPreview
          values={values}
          targetReady={targetReady}
          width={videoWidth}
          height={videoHeight}
        />
        {capability && (
          <div className="overlay-preview-state" role="group" aria-label={t("config.overlay.preview.state")}> 
            <button
              type="button"
              aria-pressed={!targetReady}
              onClick={() => setTargetReady(false)}
            >
              {t("config.overlay.preview.idle")}
            </button>
            <button
              type="button"
              aria-pressed={targetReady}
              onClick={() => setTargetReady(true)}
            >
              {t("config.overlay.preview.ready")}
            </button>
          </div>
        )}
      </div>

      <div className="overlay-settings__editor">
        <div className="overlay-master-toggle">
          <div>
            <strong>{t("config.overlay.enable")}</strong>
            <small>{values.enabled ? t("common.enabled") : t("common.disabled")}</small>
          </div>
          <button
            className="config-toggle"
            type="button"
            role="switch"
            aria-label={t("config.overlay.enable")}
            aria-checked={values.enabled}
            disabled={disabled}
            onClick={() => onChange((overlay) => { overlay.enabled = !overlay.enabled; })}
          >
            <span />
          </button>
        </div>

        {!capability ? (
          <p className="overlay-settings__legacy">{t("config.overlay.legacy")}</p>
        ) : (
          <>
            <SettingGroup
              icon={<Type size={16} />}
              title={t("config.overlay.text.title")}
              description={t("config.overlay.text.description")}
            >
              <div className="overlay-switch-row">
                <span>{t("config.overlay.text.enable")}</span>
                <button
                  className="config-toggle"
                  type="button"
                  role="switch"
                  aria-label={t("config.overlay.text.enable")}
                  aria-checked={text?.enabled === true}
                  disabled={disabled}
                  onClick={() => updateText((entry) => { entry.enabled = !entry.enabled; })}
                >
                  <span />
                </button>
              </div>
              <label className="overlay-text-field">
                <span>{t("config.overlay.text.content")}</span>
                <input
                  type="text"
                  value={text?.content ?? ""}
                  disabled={disabled || !text?.enabled}
                  aria-invalid={byteLength > capability.textMaxBytes}
                  onChange={(event) => updateText((entry) => { entry.content = event.target.value; })}
                />
                <small>{byteLength} / {capability.textMaxBytes} bytes</small>
              </label>
              <ColorField
                label={t("config.overlay.text.color")}
                value={text?.color ?? "#FFFFFF"}
                disabled={disabled || !text?.enabled}
                onChange={(color) => updateText((entry) => { entry.color = color; })}
              />
              <label className="overlay-select-field">
                <span>{t("config.overlay.text.position")}</span>
                <select
                  value={text?.position ?? "top-left"}
                  disabled={disabled || !text?.enabled}
                  onChange={(event) => updateText((entry) => {
                    entry.position = event.target.value as OverlayTextPosition;
                  })}
                >
                  {(["top-left", "top-right", "bottom-left", "bottom-right", "custom"] as const).map((position) => (
                    <option key={position} value={position}>{t(`config.overlay.positions.${position}`)}</option>
                  ))}
                </select>
              </label>
              {text?.position === "custom" && (
                <div className="overlay-coordinate-fields">
                  <label>
                    <span>X</span>
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0, videoWidth - 1)}
                      value={text.x}
                      disabled={disabled || !text.enabled}
                      onChange={(event) => updateText((entry) => { entry.x = Number(event.target.value); })}
                    />
                  </label>
                  <label>
                    <span>Y</span>
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0, videoHeight - 1)}
                      value={text.y}
                      disabled={disabled || !text.enabled}
                      onChange={(event) => updateText((entry) => { entry.y = Number(event.target.value); })}
                    />
                  </label>
                </div>
              )}
            </SettingGroup>

            <SettingGroup
              icon={<ScanLine size={16} />}
              title={t("config.overlay.ai.title")}
              description={t("config.overlay.ai.description")}
            >
              <div className="overlay-switch-row">
                <span>{t("config.overlay.ai.detection")}</span>
                <button
                  className="config-toggle"
                  type="button"
                  role="switch"
                  aria-label={t("config.overlay.ai.detection")}
                  aria-checked={values.detection.enabled}
                  disabled={disabled}
                  onClick={() => onChange((overlay) => { overlay.detection.enabled = !overlay.detection.enabled; })}
                >
                  <span />
                </button>
              </div>
              <label className="overlay-select-field">
                <span>{t("config.overlay.ai.colorMode")}</span>
                <select
                  value={values.detection.colorMode}
                  disabled={disabled || !values.detection.enabled}
                  onChange={(event) => onChange((overlay) => {
                    overlay.detection.colorMode = event.target.value as "fixed" | "model";
                  })}
                >
                  {capability.colorModes.map((mode) => (
                    <option key={mode} value={mode}>{t(`config.overlay.colorModes.${mode}`)}</option>
                  ))}
                </select>
              </label>
              {values.detection.colorMode === "fixed" && (
                <ColorField
                  label={t("config.overlay.ai.fixedColor")}
                  value={values.detection.color}
                  disabled={disabled || !values.detection.enabled}
                  onChange={(color) => onChange((overlay) => { overlay.detection.color = color; })}
                />
              )}
              <ThicknessField
                label={t("config.overlay.thickness")}
                value={values.detection.thickness}
                capability={capability.thickness}
                disabled={disabled || !values.detection.enabled}
                onChange={(value) => onChange((overlay) => { overlay.detection.thickness = value; })}
              />
              <label className="overlay-select-field">
                <span>{t("config.overlay.ai.label")}</span>
                <select
                  value={values.detection.labelMode}
                  disabled={disabled || !values.detection.enabled}
                  onChange={(event) => onChange((overlay) => {
                    overlay.detection.labelMode = event.target.value as OverlayLabelMode;
                  })}
                >
                  {capability.labelModes.map((mode) => (
                    <option key={mode} value={mode}>{t(`config.overlay.labelModes.${mode}`)}</option>
                  ))}
                </select>
              </label>

              <div className="overlay-subsection-divider" />
              <div className="overlay-switch-row">
                <span>{t("config.overlay.ai.tracking")}</span>
                <button
                  className="config-toggle"
                  type="button"
                  role="switch"
                  aria-label={t("config.overlay.ai.tracking")}
                  aria-checked={values.tracking.enabled}
                  disabled={disabled}
                  onClick={() => onChange((overlay) => { overlay.tracking.enabled = !overlay.tracking.enabled; })}
                >
                  <span />
                </button>
              </div>
              {capability.trackingBoxStyles?.length ? (
                <label className="overlay-select-field">
                  <span>{t("config.overlay.ai.boxStyle")}</span>
                  <select value={values.tracking.boxStyle ?? "rectangle"} disabled={disabled || !values.tracking.enabled}
                    onChange={(event) => onChange((overlay) => {
                      overlay.tracking.boxStyle = event.target.value as "rectangle" | "corners";
                    })}>
                    {capability.trackingBoxStyles.map((style) => (
                      <option key={style} value={style}>{t(`config.overlay.ai.boxStyles.${style}`)}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {capability.trackingHideWhenLost && (
                <div className="overlay-switch-row">
                  <span>{t("config.overlay.ai.hideWhenLost")}</span>
                  <button className="config-toggle" type="button" role="switch"
                    aria-label={t("config.overlay.ai.hideWhenLost")}
                    aria-checked={values.tracking.hideWhenLost === true}
                    disabled={disabled || !values.tracking.enabled}
                    onClick={() => onChange((overlay) => { overlay.tracking.hideWhenLost = !overlay.tracking.hideWhenLost; })}>
                    <span />
                  </button>
                </div>
              )}
              <ColorField
                label={t("config.overlay.ai.trackingColor")}
                value={values.tracking.color}
                disabled={disabled || !values.tracking.enabled}
                onChange={(color) => onChange((overlay) => { overlay.tracking.color = color; })}
              />
              <ColorField
                label={t("config.overlay.ai.lostColor")}
                value={values.tracking.lostColor}
                disabled={disabled || !values.tracking.enabled}
                onChange={(color) => onChange((overlay) => { overlay.tracking.lostColor = color; })}
              />
              <ThicknessField
                label={t("config.overlay.thickness")}
                value={values.tracking.thickness}
                capability={capability.thickness}
                disabled={disabled || !values.tracking.enabled}
                onChange={(value) => onChange((overlay) => { overlay.tracking.thickness = value; })}
              />
            </SettingGroup>

            <SettingGroup
              icon={<Crosshair size={16} />}
              title={t("config.overlay.reticle.title")}
              description={t("config.overlay.reticle.description")}
            >
              <div className="overlay-switch-row">
                <span>{t("config.overlay.reticle.enable")}</span>
                <button
                  className="config-toggle"
                  type="button"
                  role="switch"
                  aria-label={t("config.overlay.reticle.enable")}
                  aria-checked={values.reticle.enabled}
                  disabled={disabled}
                  onClick={() => onChange((overlay) => { overlay.reticle.enabled = !overlay.reticle.enabled; })}
                >
                  <span />
                </button>
              </div>
              <div className="reticle-template-field">
                <span>{t("config.overlay.reticle.template")}</span>
                <div className="reticle-template-grid">
                  {capability.reticleTemplates.map((template) => (
                    <button
                      type="button"
                      key={template}
                      aria-pressed={values.reticle.template === template}
                      disabled={disabled || !values.reticle.enabled}
                      onClick={() => onChange((overlay) => { overlay.reticle.template = template; })}
                    >
                      <span className="reticle-template-grid__visual">
                        <ReticleShape template={template} />
                      </span>
                      <small>{t(`config.overlay.templates.${template}`)}</small>
                    </button>
                  ))}
                </div>
              </div>
              <ColorField
                label={t("config.overlay.reticle.idleColor")}
                value={values.reticle.idleColor}
                disabled={disabled || !values.reticle.enabled}
                onChange={(color) => onChange((overlay) => { overlay.reticle.idleColor = color; })}
              />
              <ColorField
                label={t("config.overlay.reticle.readyColor")}
                value={values.reticle.readyColor}
                disabled={disabled || !values.reticle.enabled}
                onChange={(color) => onChange((overlay) => { overlay.reticle.readyColor = color; })}
              />
              <ThicknessField
                label={t("config.overlay.thickness")}
                value={values.reticle.thickness}
                capability={capability.thickness}
                disabled={disabled || !values.reticle.enabled}
                onChange={(value) => onChange((overlay) => { overlay.reticle.thickness = value; })}
              />
              <div className="overlay-switch-row">
                <span>{t("config.overlay.reticle.showWhileTracking")}</span>
                <button
                  className="config-toggle"
                  type="button"
                  role="switch"
                  aria-label={t("config.overlay.reticle.showWhileTracking")}
                  aria-checked={values.reticle.showWhileTracking}
                  disabled={disabled || !values.reticle.enabled}
                  onClick={() => onChange((overlay) => {
                    overlay.reticle.showWhileTracking = !overlay.reticle.showWhileTracking;
                  })}
                >
                  <span />
                </button>
              </div>
            </SettingGroup>
          </>
        )}
      </div>
    </div>
  );
}
