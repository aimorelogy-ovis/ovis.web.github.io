import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

const LANGUAGE_TEST_TITLE = "defaults to English and persists a Simplified Chinese selection";
const THEME_TEST_TITLE = "defaults to dark and persists a light theme selection";
const RESPONSIVE_IDLE_TEST_TITLE = "keeps the 1080p idle composition proportional at 2K";
const RESPONSIVE_CONFIG_TEST_TITLE =
  "scales the configuration workspace and keeps the dashboard fixed at 2K";
const ENGLISH_MOBILE_CONFIG_TEST_TITLE =
  "keeps the English configuration workspace usable on mobile";
const RUNTIME_LOCALIZATION_TEST_TITLE =
  "localizes device runtime messages and model catalog values in English";

test.beforeEach(async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const events = new EventTarget();
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        getDevices: async () => [],
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
  });
  if (
    [
      LANGUAGE_TEST_TITLE,
      THEME_TEST_TITLE,
      RESPONSIVE_IDLE_TEST_TITLE,
      RESPONSIVE_CONFIG_TEST_TITLE,
      ENGLISH_MOBILE_CONFIG_TEST_TITLE,
      RUNTIME_LOCALIZATION_TEST_TITLE,
    ].includes(testInfo.title)
  ) {
    return;
  }
  await page.addInitScript(() => {
    localStorage.setItem("ovis_manager_language", "zh-CN");
  });
});

async function readCanvasSignal(page: Page) {
  return page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl2");
    if (!gl) {
      return {
        width: 0,
        height: 0,
        visiblePixels: 0,
        hash: 0,
        minY: 0,
        maxY: 0,
      };
    }

    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    let visiblePixels = 0;
    let hash = 2166136261;
    let minY = height;
    let maxY = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 24) {
        visiblePixels += 1;
        const y = Math.floor(index / 4 / width);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (index % 388 === 0) {
        hash ^= pixels[index] + pixels[index + 1] * 3 + pixels[index + 2] * 7;
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
    return { width, height, visiblePixels, hash, minY, maxY };
  });
}

const deviceInfo = {
  protocol: "ovis-device",
  api_version: 1,
  device_id: "OVIS-1842-00123456",
  name: "OVIS Camera",
  model: "OVIS",
  serial: "OVIS-1842-00123456",
  firmware_version: "1.0.0",
  manager_version: "1.0.0",
};

const secondDeviceInfo = {
  ...deviceInfo,
  device_id: "OVIS-1842-00987654",
  name: "OVIS Camera B",
  serial: "OVIS-1842-00987654",
};

const processingCapability = (width: number, height: number) => ({
  min_width: 160,
  max_width: width,
  min_height: 96,
  max_height: height,
  step: 2,
  default: { width, height },
});

const configCapabilities = {
  schema_version: 4,
  outputs: {
    rtsp: { supported: true },
    uvc: { supported: true },
  },
  video: {
    main: {
      profiles: [
        {
          id: "1080p",
          width: 1920,
          height: 1080,
          fps_options: [15, 25, 30, 60],
          bitrate_min: 512,
          bitrate_max: 15000,
        },
        {
          id: "720p",
          width: 1280,
          height: 720,
          fps_options: [15, 25, 30],
          bitrate_min: 384,
          bitrate_max: 8000,
        },
      ],
    },
    sub: {
      profiles: [
        {
          id: "768x572",
          width: 768,
          height: 572,
          fps_options: [15, 25, 30],
          bitrate_min: 128,
          bitrate_max: 4000,
        },
      ],
    },
  },
  features: {
    osd: true,
    object_detection: true,
    face_detection: true,
    motion_detection: true,
    human_pose: true,
    object_tracking: true,
  },
  overlay: {
    supported: true,
    maxTexts: 3,
    textMaxBytes: 63,
    utf8Text: false,
    thickness: { min: 1, max: 4 },
    colorModes: ["fixed", "model"],
    labelModes: ["none", "class", "class_score"],
    reticleTemplates: [
      "rectangle",
      "corners",
      "crosshair",
      "crosshair_dot",
      "bracket_cross",
      "circle",
    ],
    streams: {
      main: { text: true, ai: true },
      sub: { text: true, ai: false },
    },
  },
  ai: {
    max_active_tpu_features: 1,
    features: [
      {
        id: "object",
        name: "目标检测",
        model_selectable: true,
        processing_size: processingCapability(448, 256),
      },
      { id: "face", name: "人脸检测", model: "SCRFD", processing_size: processingCapability(768, 432) },
      { id: "motion", name: "移动检测", processing_size: processingCapability(640, 360) },
      { id: "human_pose", name: "人体姿态", model: "YOLOv8 Pose", processing_size: processingCapability(640, 384) },
      {
        id: "object_tracking",
        name: "单目标跟踪",
        model: "YOLOv8n + FearTrack",
        search_methods: ["color", "fastsam"],
        detection_processing_size: { fixed: true, width: 640, height: 384 },
        tracking_processing_size: { fixed: true, width: 1920, height: 1080 },
      },
    ],
    motion_detection: true,
  },
};

const currentConfig = {
  revision: "a81f36c2",
  values: {
    outputs: {
      rtsp: { enabled: false },
      uvc: { enabled: true },
    },
    video: {
      main: { profile: "1080p", fps: 30, bitrate_kbps: 10000 },
      sub: {
        enabled: true,
        profile: "768x572",
        fps: 30,
        bitrate_kbps: 1000,
      },
    },
    overlay: {
      enabled: true,
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
        enabled: true,
        colorMode: "fixed",
        color: "#00D9FF",
        thickness: 2,
        labelMode: "none",
      },
      tracking: {
        enabled: true,
        color: "#FFB000",
        lostColor: "#FF3030",
        thickness: 3,
      },
      reticle: {
        enabled: true,
        template: "corners",
        idleColor: "#FFFFFF",
        readyColor: "#FFC247",
        thickness: 2,
        showWhileTracking: false,
      },
    },
    detection: {
      object: {
        enabled: true,
        threshold: 0.7,
        processing_size: { width: 448, height: 256 },
        model: {
          source: "builtin",
          id: "builtin.object_detection",
          runtime_model: "YOLOV8_DETECTION",
        },
      },
      face: { enabled: false, threshold: 0.5, processing_size: { width: 768, height: 432 } },
      human_pose: { enabled: false, threshold: 0.65, processing_size: { width: 640, height: 384 } },
      object_tracking: {
        enabled: false,
        search_method: "color",
        use_kalman: true,
        score_threshold: 0.5,
        detection_processing_size: { width: 640, height: 384 },
        tracking_processing_size: { width: 1920, height: 1080 },
      },
      motion: { enabled: false, sensitivity: 50, processing_size: { width: 640, height: 360 } },
    },
  },
};

const splitDetectionTrackingConfig = () => {
  const config = structuredClone(currentConfig) as typeof currentConfig & {
    values: typeof currentConfig.values & {
      tracking: {
        single_object: {
          enabled: boolean;
          default_target_source: "detection" | "fastsam" | "color" | "box";
          fallback_target_source: "fastsam" | "color" | "box";
          score_threshold: number;
          use_kalman: boolean;
          processing_size: { width: number; height: number };
          fastsam: { threshold: number };
          color: { tolerance: number };
        };
      };
    };
  };
  config.values.detection.object.model = "builtin.person_detection" as never;
  delete (config.values.detection as unknown as Record<string, unknown>)
    .object_tracking;
  config.values.tracking = {
    single_object: {
      enabled: true,
      default_target_source: "detection",
      fallback_target_source: "box",
      score_threshold: 0.55,
      use_kalman: true,
      processing_size: { width: 1920, height: 1080 },
      fastsam: { threshold: 0.45 },
      color: { tolerance: 30 },
    },
  };
  return config;
};

const modelImporterCatalog = {
  upload: {
    strategy: "single-request",
    contentType: "application/octet-stream",
    contentLengthRequired: true,
    contentLengthSource: "body",
    contentRange: false,
    resumable: false,
    retryOffset: 0,
    progressSource: "client",
  },
  availableBytes: 52_428_800,
  importers: [
    {
      id: "detection.yolov8",
      schemaVersion: 1,
      name: "YOLOv8 目标检测",
      task: "object_detection",
      enabled: true,
      deployable: true,
      maxFileSize: 16_777_216,
      runtimeConsumers: ["ipcamera.object_detection"],
      metadataSchema: {
        type: "object",
        additionalProperties: false,
        required: ["labels"],
        properties: {
          labels: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 96 },
          },
        },
      },
      deploymentSchema: {
        type: "object",
        required: ["threshold"],
        properties: {
          threshold: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        },
      },
      defaults: null,
      constraints: {
        properties: { labels: { maxItems: 80 } },
      },
    },
  ],
};

const requestHost = (route: Route) => new URL(route.request().url()).hostname;

const fulfillJson = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

interface MockPolicyUsbDevice {
  deviceId: string;
  vendorId?: number;
  productId?: number;
  connected?: boolean;
  authorized?: boolean;
  failOpen?: boolean;
  failClaim?: boolean;
  failRead?: boolean;
  invalidProtocol?: boolean;
  disconnectOnCommit?: boolean;
  deferAuthorization?: boolean;
}

async function mockPolicyWebUsbDevices(
  page: Page,
  specifications: MockPolicyUsbDevice[],
) {
  await page.addInitScript((deviceSpecifications) => {
    const validConfiguration = {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 2,
          alternates: [
            {
              interfaceClass: 0xff,
              interfaceSubclass: 0x4f,
              interfaceProtocol: 0x01,
            },
          ],
        },
      ],
    };
    const events = new EventTarget();
    const commandLog: number[] = [];
    const entries = deviceSpecifications.map((specification) => {
      let opened = false;
      let connected = specification.connected ?? true;
      let authorized = specification.authorized ?? true;
      let commitIssued = false;
      let usbInfo = {
        protocol: 2,
        device_id: specification.deviceId,
        subnet: -1,
        pending_subnet: -1,
        ncm_active: false,
      };
      const usbDevice = {
        vendorId: specification.vendorId ?? 0x3346,
        productId: specification.productId ?? 0x100e,
        serialNumber: specification.deviceId,
        get opened() {
          return opened;
        },
        configuration: validConfiguration,
        configurations: [validConfiguration],
        open: async () => {
          if (!connected) throw new DOMException("Disconnected", "NetworkError");
          if (specification.failOpen) {
            throw new DOMException("Open failed", "NetworkError");
          }
          opened = true;
        },
        close: async () => {
          opened = false;
        },
        selectConfiguration: async () => undefined,
        claimInterface: async () => {
          if (specification.failClaim) {
            throw new DOMException("Interface claim failed", "NetworkError");
          }
        },
        controlTransferIn: async (setup: { request: number }) => {
          commandLog.push(setup.request);
          if (commitIssued && specification.disconnectOnCommit) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (!connected || specification.failRead) {
            throw new DOMException("Read failed", "NetworkError");
          }
          const value = specification.invalidProtocol
            ? { ...usbInfo, protocol: 99 }
            : usbInfo;
          const bytes = new TextEncoder().encode(JSON.stringify(value));
          return { data: new DataView(bytes.buffer) };
        },
        controlTransferOut: async (
          setup: { request: number },
          data: Uint8Array,
        ) => {
          commandLog.push(setup.request);
          if (!connected) throw new DOMException("Disconnected", "NetworkError");
          if (setup.request === 0x03) {
            usbInfo = { ...usbInfo, pending_subnet: data[0] };
          } else if (setup.request === 0x04) {
            usbInfo = {
              ...usbInfo,
              subnet: usbInfo.pending_subnet,
              pending_subnet: -1,
            };
            commitIssued = true;
            if (specification.disconnectOnCommit) {
              window.setTimeout(() => {
                connected = false;
                const event = new Event("disconnect");
                Object.defineProperty(event, "device", { value: usbDevice });
                events.dispatchEvent(event);
              }, 0);
            }
          } else if (setup.request === 0x05) {
            usbInfo = { ...usbInfo, pending_subnet: -1 };
          }
          return { status: "ok" };
        },
      };
      return {
        device: usbDevice,
        isConnected: () => connected,
        isAuthorized: () => authorized,
        deferAuthorization: specification.deferAuthorization ?? false,
        authorize: () => {
          authorized = true;
          return usbDevice;
        },
        connect: () => {
          connected = true;
          const event = new Event("connect");
          Object.defineProperty(event, "device", { value: usbDevice });
          events.dispatchEvent(event);
        },
        disconnect: () => {
          connected = false;
          const event = new Event("disconnect");
          Object.defineProperty(event, "device", { value: usbDevice });
          events.dispatchEvent(event);
        },
      };
    });
    let requestCount = 0;
    let lastRequestOptions: unknown = null;
    let resolvePendingRequest: (() => void) | null = null;
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        getDevices: async () =>
          entries
            .filter((entry) => entry.isConnected() && entry.isAuthorized())
            .map((entry) => entry.device),
        requestDevice: async (options: unknown) => {
          requestCount += 1;
          lastRequestOptions = options;
          const entry = entries.find(
            (candidate) => candidate.isConnected() && !candidate.isAuthorized(),
          );
          if (!entry) throw new DOMException("No device selected", "NotFoundError");
          if (entry.deferAuthorization) {
            return new Promise((resolve) => {
              resolvePendingRequest = () => resolve(entry.authorize());
            });
          }
          return entry.authorize();
        },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
    Object.defineProperty(window, "__ovisUsbTestDevices", {
      configurable: true,
      value: entries,
    });
    Object.defineProperty(window, "__ovisUsbRequestState", {
      configurable: true,
      value: {
        get count() {
          return requestCount;
        },
        get options() {
          return lastRequestOptions;
        },
      },
    });
    Object.defineProperty(window, "__ovisResolveUsbRequest", {
      configurable: true,
      value: () => resolvePendingRequest?.(),
    });
    Object.defineProperty(window, "__ovisUsbCommandLog", {
      configurable: true,
      value: commandLog,
    });
  }, specifications);
}

async function discoverSingleDevice(
  page: Page,
  deviceInfoHandler?: (route: Route) => Promise<unknown>,
) {
  await page.route("**/api/v1/device/info", (route) => {
    if (deviceInfoHandler) return deviceInfoHandler(route);
    if (requestHost(route) === "192.168.42.1") {
      return fulfillJson(route, deviceInfo);
    }
    return route.abort("connectionrefused");
  });
  await page.goto("./");
  await page
    .getByRole("button", { name: /搜索设备|Discover devices/ })
    .click();
  await expect(
    page.getByRole("radio", { name: /OVIS Camera OVIS-1842-00123456/ }),
  ).toBeVisible();
}

async function mockConfigurationRead(
  page: Page,
  document = currentConfig,
  models: unknown[] = [],
) {
  await page.route("**/api/v1/models/importers", (route) =>
    fulfillJson(route, modelImporterCatalog),
  );
  await page.route("**/api/v1/models", (route) =>
    fulfillJson(route, {
      models,
      storage: {
        totalBytes: 67_108_864,
        availableBytes: 52_428_800,
        reservedBytes: 2_097_152,
      },
    }),
  );
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config", (route) => {
    if (route.request().method() === "GET") {
      return fulfillJson(route, document);
    }
    return route.fallback();
  });
}

test("opens device discovery without a managed workspace policy", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "managed", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "device", { configurable: true, value: undefined });
  });
  await page.goto("./");

  await expect(page.getByRole("button", { name: "搜索设备" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /安装 OVIS 支持包/ })).toHaveCount(0);
});

test(RUNTIME_LOCALIZATION_TEST_TITLE, async ({ page }) => {
  const model = {
    id: "018f1234abcd5678",
    status: "ready",
    importerId: "detection.yolov8",
    schemaVersion: 1,
    name: "Helmet detector",
    fileSize: 3_145_728,
    createdAt: 1_784_505_600,
    committedAt: 1_784_505_605,
    modelType: "YOLOV8",
    task: "目标检测",
    deployable: true,
    metadataSummary: { labelsCount: 2 },
    active: false,
    referenced: false,
    tensorSize: { width: 640, height: 640 },
    deployment: {
      threshold: 0.3,
      processingSize: { width: 448, height: 256 },
    },
  };
  let revision = currentConfig.revision;
  let values = structuredClone(currentConfig.values);

  await page.route("**/api/v1/models/importers", (route) =>
    fulfillJson(route, modelImporterCatalog),
  );
  await page.route("**/api/v1/models", (route) =>
    fulfillJson(route, {
      models: [model],
      storage: {
        totalBytes: 67_108_864,
        availableBytes: 52_428_800,
        reservedBytes: 2_097_152,
      },
    }),
  );
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config/validate", (route) =>
    fulfillJson(route, {
      valid: true,
      errors: [],
      warnings: [{
        field: "outputs.uvc.enabled",
        code: "USB_RECONNECT",
        message: "UVC 变更会短暂中断 USB 连接",
      }],
      requires: ["ipcamera_restart", "management_reconnect"],
    }),
  );
  await page.route("**/api/v1/config/apply", (route) =>
    fulfillJson(route, { task_id: 91 }),
  );
  await page.route("**/api/v1/tasks/91", (route) =>
    fulfillJson(route, {
      id: 91,
      state: "running",
      stage: "restarting_ipcamera",
      progress: 60,
      message: "正在重启视频服务",
      rolled_back: false,
    }),
  );
  await page.route("**/api/v1/config", async (route) => {
    if (route.request().method() === "PUT") {
      const payload = await route.request().postDataJSON() as {
        values: typeof currentConfig.values;
      };
      values = structuredClone(payload.values);
      revision = "english-runtime-test";
      return fulfillJson(route, {
        saved: true,
        revision,
        restart_required: true,
      });
    }
    return fulfillJson(route, { revision, values });
  });

  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  const modelTable = page.locator(".model-table");
  await expect(modelTable).toContainText("Object detection");
  await expect(modelTable).toContainText("Ready");
  await expect(modelTable).not.toContainText("目标检测");
  await expect(modelTable).not.toContainText("已就绪");

  await page.getByRole("button", { name: "Add model" }).click();
  await page.getByRole("button", { name: /Object detection/ }).click();
  await expect(page.getByText("YOLOv8 object detection", { exact: true })).toBeVisible();
  await expect(page.getByText("YOLOv8 目标检测", { exact: true })).toHaveCount(0);

  await page.getByRole("switch", { name: "Enable OSD" }).click();
  await page.getByRole("button", { name: "Apply configuration" }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Apply these configuration changes?",
  });
  await expect(confirmation).not.toContainText("UVC 变更会短暂中断 USB 连接");
  await expect(confirmation).toContainText("management network may reconnect briefly");
  await confirmation.getByRole("button", { name: "Confirm and apply" }).click();
  await expect(page.getByText("Restarting the video service")).toBeVisible();
  await expect(page.getByText("正在重启视频服务")).toHaveCount(0);
});

test("discovers network devices when WebUSB is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "usb", { configurable: true, value: undefined });
  });
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) === "192.168.42.1") return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });
  await page.goto("./");

  await expect(page.getByRole("button", { name: "授权 USB 设备" })).toHaveCount(0);
  await page.getByRole("button", { name: "搜索设备" }).click();
  await expect(page.getByRole("radio", { name: /OVIS Camera/ })).toBeVisible();
});

test("shows the initial discovery workspace", async ({ page }) => {
  await page.goto("./");

  await expect(page.getByRole("heading", { name: "设备连接" })).toHaveCount(0);
  const companyLogo = page.locator(".brand__company-logo");
  await expect(companyLogo).toBeVisible();
  await expect(companyLogo).toHaveAttribute(
    "src",
    /images\/aimorelogy-logo\.png$/,
  );
  await expect(page.getByRole("button", { name: "搜索设备" })).toBeVisible();
  await expect(page.getByRole("button", { name: /授权 USB|Authorize USB/ })).toHaveCount(0);
  await expect(page.getByText("等待搜索")).toBeVisible();
  await expect(page.getByText("参数配置")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/ovis-idle-desktop.png", fullPage: true });
});

test(LANGUAGE_TEST_TITLE, async ({ page }) => {
  await page.route("**/models/*.glb", (route) => route.abort("blockedbyclient"));
  await page.goto("./");

  await expect(page.getByRole("heading", { name: "Device Connection" })).toHaveCount(0);
  await expect(page.getByText("Ready to discover")).toBeVisible();
  const languageButton = page.getByRole("button", { name: "Language" });
  await languageButton.click();
  await page
    .getByRole("menuitemradio", { name: "Simplified Chinese" })
    .click();

  await expect(page.getByRole("heading", { name: "设备连接" })).toHaveCount(0);
  await expect(page.getByText("等待搜索")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "设备连接" })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test(THEME_TEST_TITLE, async ({ page }) => {
  await page.goto("./");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const themeButton = page.getByRole("button", { name: "Switch to light theme" });
  await expect(themeButton).toBeVisible();
  await themeButton.click();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Switch to dark theme" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("ovis_manager_theme")))
    .toBe("light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Switch to dark theme" })).toBeVisible();
});

test(RESPONSIVE_IDLE_TEST_TITLE, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("./");
  await expect(
    page.getByRole("img", {
      name: "Interactive 3D view of the OVIS camera module",
    }),
  ).toHaveAttribute("data-model-status", "ready", { timeout: 25_000 });

  const workspace = page.locator(".workspace-panel");
  const heading = page.getByRole("heading", { name: "Discover OVIS Devices" });
  const workspace1080 = await workspace.boundingBox();
  expect(workspace1080?.x).toBeCloseTo(0, 0);
  expect(workspace1080?.width).toBeCloseTo(1920, 0);
  const headingSize1080 = await heading.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  await page.screenshot({ path: "/tmp/ovis-idle-1080-en.png", fullPage: true });

  await page.setViewportSize({ width: 2048, height: 1024 });
  const idleLayout = page.locator(".idle-layout");
  const idleLayoutBounds = await idleLayout.boundingBox();
  expect(idleLayoutBounds?.width).toBeLessThanOrEqual(1541);
  expect(idleLayoutBounds?.x).toBeGreaterThan(200);
  expect(
    Math.abs(
      (idleLayoutBounds?.x ?? 0) * 2 +
        (idleLayoutBounds?.width ?? 0) -
        2048,
    ),
  ).toBeLessThan(2);
  await page.screenshot({ path: "/tmp/ovis-idle-2048.png", fullPage: true });

  await page.setViewportSize({ width: 2200, height: 1238 });
  const workspaceIntermediate = await workspace.boundingBox();
  const intermediateRatio = 2200 / 1920;
  expect(
    (workspaceIntermediate?.width ?? 0) / (workspace1080?.width ?? 1),
  ).toBeCloseTo(intermediateRatio, 1);
  expect(
    (workspaceIntermediate?.height ?? 0) / (workspace1080?.height ?? 1),
  ).toBeCloseTo(intermediateRatio, 1);

  await page.setViewportSize({ width: 2560, height: 1440 });
  const workspace2K = await workspace.boundingBox();
  const headingSize2K = await heading.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );

  expect((workspace2K?.width ?? 0) / (workspace1080?.width ?? 1)).toBeCloseTo(
    4 / 3,
    1,
  );
  expect((workspace2K?.height ?? 0) / (workspace1080?.height ?? 1)).toBeCloseTo(
    4 / 3,
    1,
  );
  expect(workspace2K?.x).toBeCloseTo(0, 0);
  expect(workspace2K?.width).toBeCloseTo(2560, 0);
  const pageHeight = await page.evaluate(() => ({
    document: document.documentElement.scrollHeight,
    viewport: document.documentElement.clientHeight,
  }));
  expect(pageHeight.document).toBe(pageHeight.viewport);
  expect(headingSize2K / headingSize1080).toBeCloseTo(4 / 3, 1);
  await page.screenshot({ path: "/tmp/ovis-idle-2k-en.png", fullPage: true });
});

test("renders and rotates the optimized product model", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("./");
  const model = page.getByRole("img", { name: "OVIS 相机模组 3D 展示" });
  await expect(model).toHaveAttribute("data-model-status", "ready", {
    timeout: 25_000,
  });
  const canvas = model.locator("canvas");
  await expect(canvas).toBeVisible();

  await page.waitForTimeout(250);
  const firstFrame = await readCanvasSignal(page);
  expect(firstFrame.width).toBeGreaterThan(400);
  expect(firstFrame.height).toBeGreaterThan(400);
  expect(firstFrame.visiblePixels).toBeGreaterThan(
    firstFrame.width * firstFrame.height * 0.02,
  );

  await page.waitForTimeout(900);
  const rotatedFrame = await readCanvasSignal(page);
  expect(rotatedFrame.hash).not.toBe(firstFrame.hash);
  expect(rotatedFrame.minY).toBeGreaterThan(rotatedFrame.height * 0.03);
  expect(rotatedFrame.maxY).toBeLessThan(rotatedFrame.height * 0.97);

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.44, {
      steps: 8,
    });
    await page.mouse.up();
  }
  await page.waitForTimeout(250);
  const draggedFrame = await readCanvasSignal(page);
  expect(draggedFrame.hash).not.toBe(rotatedFrame.hash);
  expect(draggedFrame.minY).toBeGreaterThan(draggedFrame.height * 0.03);
  expect(draggedFrame.maxY).toBeLessThan(draggedFrame.height * 0.97);
  await page.screenshot({ path: "/tmp/ovis-model-desktop.png", fullPage: true });
});

test("scans with bounded concurrency and deduplicates device ids", async ({
  page,
}) => {
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let firstRequestedHost: string | null = null;
  const requestedHosts = new Set<string>();

  await page.addInitScript(() => {
    let permissionQueryCount = 0;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () => ({
          state: permissionQueryCount++ === 0 ? "prompt" : "granted",
        }),
      },
    });
  });

  await page.route("**/api/v1/device/info", async (route) => {
    expect(route.request().method()).toBe("GET");
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    const host = requestHost(route);
    firstRequestedHost ??= host;
    requestedHosts.add(host);
    await new Promise((resolve) => setTimeout(resolve, 45));
    activeRequests -= 1;

    if (host === "192.168.42.1" || host === "192.168.43.1") {
      return fulfillJson(route, deviceInfo);
    }
    if (host === "192.168.44.1") {
      return fulfillJson(route, secondDeviceInfo);
    }
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await expect(page.getByText("发现 2 台 OVIS 设备")).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(2);
  const productImages = page.locator(".device-result__visual img");
  await expect(productImages).toHaveCount(2);
  await expect(productImages.first()).toBeVisible();
  await productImages
    .first()
    .evaluate((image: HTMLImageElement) => image.decode());
  const imageMetrics = await productImages.first().evaluate((image) => ({
    complete: (image as HTMLImageElement).complete,
    naturalWidth: (image as HTMLImageElement).naturalWidth,
    renderedWidth: image.getBoundingClientRect().width,
  }));
  expect(imageMetrics.complete).toBe(true);
  expect(imageMetrics.naturalWidth).toBe(978);
  expect(imageMetrics.renderedWidth).toBeGreaterThan(200);
  const imageBottomGap = await productImages.first().evaluate((image) => {
    const imageBounds = image.getBoundingClientRect();
    const visualBounds = image.parentElement!.getBoundingClientRect();
    return visualBounds.bottom - imageBounds.bottom;
  });
  expect(imageBottomGap).toBeGreaterThanOrEqual(14);
  expect(requestedHosts.size).toBe(256);
  expect(firstRequestedHost).toBe("192.168.0.1");
  expect(maximumActiveRequests).toBeGreaterThan(1);
  expect(maximumActiveRequests).toBeLessThanOrEqual(16);
  const resultsLayout = await page.evaluate(() => {
    const workspace = document.querySelector(".workspace-panel")!;
    return {
      x: workspace.getBoundingClientRect().x,
      width: workspace.getBoundingClientRect().width,
      viewportWidth: document.documentElement.clientWidth,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: document.documentElement.clientHeight,
      resultsOverflowY: getComputedStyle(
        document.querySelector(".device-results")!,
      ).overflowY,
    };
  });
  expect(resultsLayout.x).toBe(0);
  expect(resultsLayout.width).toBe(resultsLayout.viewportWidth);
  expect(resultsLayout.documentHeight).toBe(resultsLayout.viewportHeight);
  expect(resultsLayout.resultsOverflowY).toBe("auto");
  await page.screenshot({ path: "/tmp/ovis-results-desktop.png", fullPage: true });
});

test("merges initialized network and authorized WebUSB devices", async ({ page }) => {
  const usbDeviceId = "OVIS-1842-USB000000000001";
  await mockPolicyWebUsbDevices(page, [{ deviceId: usbDeviceId }]);
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) === "192.168.42.1") {
      return fulfillJson(route, deviceInfo);
    }
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(
    page.getByRole("radio", { name: new RegExp(usbDeviceId) }),
  ).toBeVisible();
  const uninitializedResult = page.getByRole("radio", {
    name: new RegExp(usbDeviceId),
  });
  const uninitializedImage = uninitializedResult.locator("img");
  await expect(uninitializedImage).toHaveCSS(
    "filter",
    "grayscale(1) brightness(0.76) contrast(1.14)",
  );
  await uninitializedResult.hover();
  await expect(uninitializedImage).toHaveCSS(
    "filter",
    "grayscale(1) brightness(0.76) contrast(1.14)",
  );
  await expect(page.getByText("需要初始化")).toBeVisible();
  await page.screenshot({ path: "/tmp/ovis-unified-discovery.png", fullPage: true });

  await page.getByRole("radio", { name: new RegExp(usbDeviceId) }).click();
  await page.getByRole("button", { name: "初始化设备" }).click();
  await expect(
    page.getByRole("heading", { name: "初始化 OVIS 设备" }),
  ).toBeVisible();
  await expect(page.getByText(usbDeviceId)).toBeVisible();
  await expect(page.getByText("设备配置")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/ovis-device-initialization.png", fullPage: true });
  await page.getByLabel("NCM 网段").fill("42");
  await page.getByRole("button", { name: "初始化设备" }).click();
  await expect(
    page.getByText("192.168.42.1 已被另一台经过验证的 OVIS 设备占用。"),
  ).toBeVisible();
});

test("prefers a verified network result over WebUSB for the same device id", async ({
  page,
}) => {
  await mockPolicyWebUsbDevices(page, [{ deviceId: deviceInfo.device_id }]);
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) === "192.168.42.1") {
      return fulfillJson(route, deviceInfo);
    }
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(page.getByRole("radio")).toHaveCount(1);
  await expect(page.getByText("在线")).toBeVisible();
  await expect(page.getByText("需要初始化")).toHaveCount(0);
});

test("discovers multiple policy USB devices and ignores one read failure", async ({
  page,
}) => {
  const firstDeviceId = "OVIS-1842-USB000000000002";
  const secondDeviceId = "OVIS-1842-USB000000000003";
  await mockPolicyWebUsbDevices(page, [
    { deviceId: firstDeviceId },
    { deviceId: "OVIS-1842-USBREADFAIL0001", failRead: true },
    { deviceId: secondDeviceId },
    { deviceId: "OVIS-1842-WRONGVENDOR0001", vendorId: 0x1234 },
  ]);
  await page.route("**/api/v1/device/info", (route) =>
    route.abort("connectionrefused"),
  );

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(page.getByRole("radio", { name: new RegExp(firstDeviceId) })).toBeVisible();
  await expect(page.getByRole("radio", { name: new RegExp(secondDeviceId) })).toBeVisible();
  await expect(page.getByText("USBREADFAIL")).toHaveCount(0);
  await expect(page.getByText("Read failed")).toBeVisible();
  await expect(page.getByText("WRONGVENDOR")).toHaveCount(0);
  const requestCount = await page.evaluate(
    () =>
      (
        window as unknown as { __ovisUsbRequestState: { count: number } }
      ).__ovisUsbRequestState.count,
  );
  expect(requestCount).toBe(0);
});

test("diagnoses USB open, interface, and protocol failures without hiding network", async ({
  page,
}) => {
  await mockPolicyWebUsbDevices(page, [
    { deviceId: "OVIS-1842-USBOPENFAIL0001", failOpen: true },
    { deviceId: "OVIS-1842-USBCLAIMFAIL001", failClaim: true },
    { deviceId: "OVIS-1842-USBPROTOFAIL001", invalidProtocol: true },
  ]);
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) === "192.168.42.1") return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(page.getByRole("radio")).toHaveCount(1);
  await expect(page.getByText(/Open failed/)).toBeVisible();
  await expect(page.getByText(/Interface claim failed/)).toBeVisible();
  await expect(page.getByText(/USB 设备返回了无效的配置响应/)).toBeVisible();
});

test("falls back to the native USB chooser from the search action", async ({ page }) => {
  const usbDeviceId = "OVIS-1842-USBMANUAL0000001";
  await mockPolicyWebUsbDevices(page, [
    { deviceId: usbDeviceId, authorized: false },
  ]);
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) === "192.168.42.1") return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(page.getByRole("radio", { name: new RegExp(usbDeviceId) })).toBeVisible();
  const requestState = await page.evaluate(() =>
    (
      window as unknown as {
        __ovisUsbRequestState: { count: number; options: unknown };
      }
    ).__ovisUsbRequestState,
  );
  expect(requestState.count).toBe(1);
  expect(requestState.options).toEqual({
    filters: [
      {
        vendorId: 0x3346,
        productId: 0x100e,
        classCode: 0xff,
        subclassCode: 0x4f,
        protocolCode: 0x01,
      },
    ],
  });
});

test("shows network devices while the native USB chooser remains open", async ({
  page,
}) => {
  const usbDeviceId = "OVIS-1842-USBDEFERRED00001";
  await mockPolicyWebUsbDevices(page, [
    { deviceId: usbDeviceId, authorized: false, deferAuthorization: true },
  ]);
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) === "192.168.42.1") return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(
    page.getByRole("radio", { name: /OVIS Camera OVIS-1842-00123456/ }),
  ).toBeVisible();
  await expect(page.getByText("网络扫描已完成，正在等待 USB 设备授权。")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "正在搜索 OVIS 设备" }),
  ).toHaveCount(0);

  await page.evaluate(() => {
    (
      window as unknown as { __ovisResolveUsbRequest: () => void }
    ).__ovisResolveUsbRequest();
  });
  await expect(page.getByRole("radio", { name: new RegExp(usbDeviceId) })).toBeVisible();
  await expect(page.getByText("网络扫描已完成，正在等待 USB 设备授权。")).toHaveCount(0);
});

test("keeps network results when the native USB chooser is cancelled", async ({ page }) => {
  await mockPolicyWebUsbDevices(page, []);
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) === "192.168.42.1") return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(
    page.getByRole("radio", { name: /OVIS Camera OVIS-1842-00123456/ }),
  ).toBeVisible();
  await expect(page.getByText("本地网络扫描失败")).toHaveCount(0);
  const requestCount = await page.evaluate(
    () =>
      (
        window as unknown as { __ovisUsbRequestState: { count: number } }
      ).__ovisUsbRequestState.count,
  );
  expect(requestCount).toBe(1);
});

test("authorizes a second USB device on a repeated search", async ({ page }) => {
  const firstDeviceId = "OVIS-1842-USBMANUAL0000002";
  const secondDeviceId = "OVIS-1842-USBMANUAL0000003";
  await mockPolicyWebUsbDevices(page, [
    { deviceId: firstDeviceId, authorized: false },
    { deviceId: secondDeviceId, authorized: false },
  ]);
  await page.route("**/api/v1/device/info", (route) =>
    route.abort("connectionrefused"),
  );

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await expect(page.getByRole("radio", { name: new RegExp(firstDeviceId) })).toBeVisible();

  await page.getByRole("button", { name: "重新搜索" }).click();
  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(page.getByRole("radio", { name: new RegExp(secondDeviceId) })).toBeVisible();
  const requestCount = await page.evaluate(
    () =>
      (
        window as unknown as { __ovisUsbRequestState: { count: number } }
      ).__ovisUsbRequestState.count,
  );
  expect(requestCount).toBe(2);
});

test("adds and removes authorized USB devices on connect and disconnect", async ({ page }) => {
  const usbDeviceId = "OVIS-1842-USB000000000005";
  await mockPolicyWebUsbDevices(page, [{ deviceId: usbDeviceId, connected: false }]);
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) === "192.168.42.1") return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await expect(
    page.getByText("未发现未初始化 USB 设备。再次搜索可授权下一台设备，或确认 OVIS 浏览器权限策略已经安装。"),
  )
    .toBeVisible();

  await page.evaluate(() => {
    const testDevices = (
      window as unknown as {
        __ovisUsbTestDevices: Array<{ connect(): void; disconnect(): void }>;
      }
    ).__ovisUsbTestDevices;
    testDevices[0].connect();
  });
  await expect(page.getByRole("radio", { name: new RegExp(usbDeviceId) })).toBeVisible();

  await page.evaluate(() => {
    const testDevices = (
      window as unknown as {
        __ovisUsbTestDevices: Array<{ connect(): void; disconnect(): void }>;
      }
    ).__ovisUsbTestDevices;
    testDevices[0].disconnect();
  });
  await expect(page.getByRole("radio", { name: new RegExp(usbDeviceId) })).toHaveCount(0);
  await expect(
    page.getByText("未发现未初始化 USB 设备。再次搜索可授权下一台设备，或确认 OVIS 浏览器权限策略已经安装。"),
  )
    .toBeVisible();
});

test("initializes an authorized USB device and reconnects only its identity", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const usbDeviceId = "OVIS-1842-USB000000000004";
  const initializedUsbInfo = {
    ...deviceInfo,
    device_id: usbDeviceId,
    serial: usbDeviceId,
  };
  let targetRequests = 0;
  await mockPolicyWebUsbDevices(page, [
    { deviceId: usbDeviceId, disconnectOnCommit: true },
  ]);
  await mockConfigurationRead(page);
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) !== "192.168.61.1") {
      return route.abort("connectionrefused");
    }
    targetRequests += 1;
    return targetRequests < 3
      ? route.abort("connectionrefused")
      : fulfillJson(route, initializedUsbInfo);
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await page.getByRole("radio", { name: new RegExp(usbDeviceId) }).click();
  await page.getByRole("button", { name: "初始化设备" }).click();
  await page.getByLabel("NCM 网段").fill("61");
  await page.getByRole("button", { name: "初始化设备" }).click();

  await expect(page.getByText("设备正在重启")).toBeVisible();
  const beforeNetworkVerification = await page.evaluate(
    (deviceId) =>
      (JSON.parse(localStorage.getItem("ovis-ncm-subnets") ?? "{}") as Record<string, number>)[
        deviceId
      ],
    usbDeviceId,
  );
  expect(beforeNetworkVerification).toBeUndefined();

  await expect(
    page.getByRole("heading", { name: "设备配置", level: 3 }),
  ).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText("192.168.61.1", { exact: true })).toBeVisible();
  expect(targetRequests).toBeGreaterThanOrEqual(2);
  const rememberedSubnets = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ovis-ncm-subnets") ?? "{}"),
  );
  expect(rememberedSubnets[usbDeviceId]).toBe(61);
  const commandLog = await page.evaluate(
    () =>
      (
        window as unknown as { __ovisUsbCommandLog: number[] }
      ).__ovisUsbCommandLog,
  );
  const quiesceIndex = commandLog.indexOf(0x02);
  expect(quiesceIndex).toBeGreaterThanOrEqual(0);
  expect(commandLog.slice(quiesceIndex, quiesceIndex + 4)).toEqual([
    0x02,
    0x03,
    0x01,
    0x04,
  ]);
});

test("stops after the permission probe when local network access is denied", async ({
  page,
}) => {
  let deviceRequests = 0;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "denied" }) },
    });
  });
  await page.route("**/api/v1/device/info", (route) => {
    deviceRequests += 1;
    return route.abort("blockedbyclient");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(page.getByText("已拒绝本地网络访问")).toBeVisible();
  await expect(page.getByText("浏览器阻止了本地网络访问")).toHaveCount(0);
  await expect(
    page.getByText("在 Chrome 中重新允许本地网络访问"),
  ).toBeVisible();
  await expect(
    page.getByText("将“本地网络访问”设为“允许”。"),
  ).toBeVisible();
  expect(deviceRequests).toBe(1);
});

test("shows the English local network permission instructions", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "denied" }) },
    });
  });
  await page.route("**/api/v1/device/info", (route) =>
    route.abort("blockedbyclient"),
  );

  await page.goto("./");
  await page.getByRole("button", { name: /Language|语言/ }).click();
  await page.getByRole("menuitemradio", { name: "English" }).click();
  await page.getByRole("button", { name: "Discover devices" }).click();

  await expect(
    page.getByText("Allow local network access in Chrome"),
  ).toBeVisible();
  await expect(
    page.getByText("Set Local network access to Allow."),
  ).toBeVisible();
});

test("reports browser blocking when every scan request fails immediately", async ({
  page,
}) => {
  await page.route("**/api/v1/device/info", (route) =>
    route.abort("blockedbyclient"),
  );

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(page.getByText("浏览器阻止了本地网络访问")).toBeVisible();
  await expect(page.getByText("未找到 OVIS 设备")).toHaveCount(0);
});

test("reports a scan network error for non-immediate transport failures", async ({
  page,
}) => {
  await page.route("**/api/v1/device/info", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(page.getByText("本地网络扫描失败")).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByText("未找到 OVIS 设备")).toHaveCount(0);
});

test("validates and connects a manually entered device address", async ({
  page,
}) => {
  let deviceRequests = 0;
  await mockConfigurationRead(page);
  await page.route("**/api/v1/device/info", async (route) => {
    deviceRequests += 1;
    if (requestHost(route) === "192.168.55.1") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return fulfillJson(route, deviceInfo);
    }
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  const addressInput = page.getByLabel("手动输入设备 IP");
  await addressInput.fill("999.168.42.1");
  await page.locator(".manual-connect").getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("请输入有效的 IPv4 地址")).toBeVisible();
  expect(deviceRequests).toBe(0);

  await addressInput.fill("192.168.55.1");
  await page.locator(".manual-connect").getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("正在验证设备地址")).toBeVisible();
  await expect(page.getByText("设备在线").first()).toBeVisible();
  await expect(page.getByText("192.168.55.1", { exact: true })).toBeVisible();
  expect(deviceRequests).toBe(1);
});

test("selects, confirms, connects, and disconnects locally", async ({ page }) => {
  await mockConfigurationRead(page);
  await discoverSingleDevice(page);

  const result = page.getByRole("radio", {
    name: /OVIS Camera OVIS-1842-00123456/,
  });
  const connectButton = page.getByRole("button", { name: "连接", exact: true });
  await expect(connectButton).toBeDisabled();
  await result.click();
  await expect(connectButton).toBeEnabled();
  await connectButton.click();

  await expect(page.getByText("设备在线").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "设备配置", level: 1 })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "设备配置", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OVIS Camera" })).toBeVisible();
  await expect(page.getByAltText("OVIS Camera 产品图")).toBeVisible();
  await expect(page.getByText("OVIS-1842-00123456").first()).toBeVisible();
  await expect(page.getByText("固件版本")).toBeVisible();
  await expect(page.getByText("Manager", { exact: true })).toBeVisible();
  await expect(page.getByText("设备配置", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("region", { name: "主码流" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "OSD 总开关" })).toBeChecked();
  await expect(page.getByText("192.168.42.1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "配置分类" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "当前设备仪表盘" }),
  ).toBeVisible();
  const pageHeight = await page.evaluate(() => ({
    document: document.documentElement.scrollHeight,
    viewport: document.documentElement.clientHeight,
  }));
  expect(pageHeight.document).toBe(pageHeight.viewport);

  const configurationEditor = page.locator(".configuration-editor");
  const videoSectionButton = page.getByRole("button", {
    name: "01 视频码流",
  });
  const detectionSectionButton = page.getByRole("button", {
    name: "04 智能检测",
  });
  const outputsSectionButton = page.getByRole("button", {
    name: "02 输出服务",
  });
  const overlaySectionButton = page.getByRole("button", {
    name: "03 OSD 设置",
  });
  const dashboard = page.getByRole("complementary", {
    name: "当前设备仪表盘",
  });
  const dashboardTop = (await dashboard.boundingBox())?.y;
  await expect(videoSectionButton).toHaveAttribute("aria-current", "true");
  await expect(outputsSectionButton).toBeVisible();
  await expect(overlaySectionButton).toBeVisible();
  await detectionSectionButton.click();
  await expect(detectionSectionButton).toHaveAttribute("aria-current", "true");
  await expect
    .poll(() => configurationEditor.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(200);
  expect((await dashboard.boundingBox())?.y).toBeCloseTo(dashboardTop ?? 0, 0);
  await videoSectionButton.click();
  await expect(videoSectionButton).toHaveAttribute("aria-current", "true");
  await page.screenshot({ path: "/tmp/ovis-connected-desktop.png", fullPage: true });

  await page.getByTitle("断开连接").click();
  await expect(page.getByText("发现 1 台 OVIS 设备")).toBeVisible();
  await expect(page.getByText("搜索完成")).toBeVisible();
});

test("previews and hot-applies capability-driven OSD settings without reconnecting", async ({
  page,
}) => {
  let activeDocument = structuredClone(currentConfig);
  let validationPayload: typeof currentConfig | null = null;
  let taskRequests = 0;
  let deviceInfoRequests = 0;
  await mockConfigurationRead(page);
  await page.unroute("**/api/v1/config");
  await page.route("**/api/v1/config", async (route) => {
    if (route.request().method() === "PUT") {
      const payload = await route.request().postDataJSON() as typeof currentConfig;
      activeDocument = {
        revision: "overlay-revision",
        values: structuredClone(payload.values),
      };
      return fulfillJson(route, {
        saved: true,
        revision: activeDocument.revision,
        restart_required: false,
      });
    }
    return fulfillJson(route, activeDocument);
  });
  await page.route("**/api/v1/config/validate", async (route) => {
    validationPayload = await route.request().postDataJSON() as typeof currentConfig;
    return fulfillJson(route, {
      valid: true,
      errors: [],
      warnings: [],
      requires: ["overlay_reload"],
    });
  });
  await page.route("**/api/v1/config/apply", (route) =>
    fulfillJson(route, { task_id: 73 }),
  );
  await page.route("**/api/v1/tasks/73", (route) => {
    taskRequests += 1;
    return fulfillJson(route, {
      id: 73,
      state: taskRequests === 1 ? "running" : "succeeded",
      progress: taskRequests === 1 ? 45 : 100,
      message: taskRequests === 1 ? "正在刷新 OSD" : "OSD 已更新",
    });
  });
  await page.route("**/api/v1/device/info", (route) => {
    deviceInfoRequests += 1;
    if (requestHost(route) === "192.168.42.1") return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "03 OSD 设置" }).click();

  const preview = page.locator(".overlay-preview");
  const previewBox = await preview.boundingBox();
  expect(previewBox).not.toBeNull();
  expect((previewBox?.width ?? 0) / (previewBox?.height ?? 1)).toBeCloseTo(16 / 9, 1);

  await page.getByRole("switch", { name: "显示自定义文字" }).click();
  await page.getByLabel("文字内容").fill("OVIS LAB");
  await page.getByLabel("显示位置").selectOption("bottom-right");
  await page.getByLabel("文字颜色").fill("#AABBCC");
  await page.getByRole("button", { name: "十字加中心点" }).click();
  const reticleGroup = page.locator(".overlay-settings__group").filter({
    hasText: "中心准星",
  });
  await reticleGroup.getByRole("slider", { name: "线条粗细" }).fill("4");

  await expect(preview.locator(".overlay-preview__text")).toHaveText("OVIS LAB");
  await expect(preview.locator(".overlay-preview__text")).toHaveClass(/bottom-right/);
  await expect(preview.locator(".overlay-reticle--crosshair_dot")).toBeVisible();

  const requestsBeforeApply = deviceInfoRequests;
  await page.getByRole("button", { name: "保存并应用" }).click();
  await expect(page.getByText("配置已应用")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("设备在线").first()).toBeVisible();
  expect(deviceInfoRequests).toBe(requestsBeforeApply);
  expect(taskRequests).toBe(2);
  expect(validationPayload).toMatchObject({
    values: {
      overlay: {
        enabled: true,
        texts: [
          {
            id: "primary",
            enabled: true,
            content: "OVIS LAB",
            streams: ["main"],
            position: "bottom-right",
            color: "#AABBCC",
          },
        ],
        reticle: {
          enabled: true,
          template: "crosshair_dot",
          thickness: 4,
        },
      },
    },
  });
});

test("imports a model with same-origin full-file upload and CSRF writes", async ({
  page,
}) => {
  await mockConfigurationRead(page);
  const importId = "018f1234abcd5678";
  const file = Buffer.from("BMOVIS\u0000test-model");
  const createdAt = 1_784_505_600;
  const emptyModelList = {
    models: [],
    storage: {
      totalBytes: 67_108_864,
      availableBytes: 52_428_800,
      reservedBytes: 2_097_152,
    },
  };
  const importTask = {
    id: importId,
    status: "created",
    importerId: "detection.yolov8",
    schemaVersion: 1,
    name: "安全帽检测",
    fileSize: file.length,
    uploadedBytes: 0,
    createdAt,
    metadata: { labels: ["person", "helmet"] },
  };
  const modelDetail = {
    id: importId,
    status: "ready",
    importerId: "detection.yolov8",
    schemaVersion: 1,
    name: "安全帽检测",
    fileSize: file.length,
    uploadedBytes: file.length,
    createdAt,
    committedAt: createdAt + 5,
    checksum: "0123456789abcdef",
    metadata: { labels: ["person", "helmet"] },
    modelType: "YOLOV8",
    task: "object_detection",
    deployable: true,
    tensorSize: { width: 640, height: 384 },
    deployment: {
      threshold: 0.5,
      processingSize: { width: 448, height: 256 },
    },
    active: false,
    referenced: false,
  };

  await page.route("**/api/v1/models", async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    return fulfillJson(route, emptyModelList);
  });
  await page.route("**/api/v1/models/imports", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.headers().authorization).toBeUndefined();
    expect(request.headers()["x-ovis-csrf"]).toBe("1");
    expect(request.postDataJSON()).toEqual({
      importerId: "detection.yolov8",
      schemaVersion: 1,
      name: "安全帽检测",
      fileSize: file.length,
      metadata: { labels: ["person", "helmet"] },
    });
    return fulfillJson(route, importTask, 201);
  });
  await page.route(`**/api/v1/models/imports/${importId}/content`, async (route) => {
    const request = route.request();
    expect(request.method()).toBe("PUT");
    expect(request.headers().authorization).toBeUndefined();
    expect(request.headers()["x-ovis-csrf"]).toBe("1");
    expect(request.headers()["content-type"]).toBe("application/octet-stream");
    expect(request.headers()["content-range"]).toBeUndefined();
    expect(request.headers()["transfer-encoding"]).toBeUndefined();
    expect(request.postDataBuffer()).toEqual(file);
    return fulfillJson(route, {
      ...importTask,
      status: "uploaded",
      uploadedBytes: file.length,
    });
  });
  await page.route(`**/api/v1/models/imports/${importId}/commit`, async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().headers()["x-ovis-csrf"]).toBe("1");
    return fulfillJson(route, modelDetail);
  });

  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: /模型管理/ }).click();
  await expect(page.getByLabel("用户名")).toHaveCount(0);
  await expect(page.getByLabel("密码")).toHaveCount(0);
  await page.getByRole("button", { name: "新增模型" }).click();
  await page.getByRole("button", { name: /目标检测/ }).click();
  await page.getByRole("button", { name: /YOLOv8 目标检测/ }).click();
  await page.getByLabel("模型名称").fill("安全帽检测");
  await page.getByLabel("有序类别列表 1").fill("person");
  await page.getByRole("button", { name: "添加一项" }).click();
  await page.getByLabel("有序类别列表 2").fill("helmet");
  await page.getByLabel("BModel 文件").setInputFiles({
    name: "helmet.bmodel",
    mimeType: "application/octet-stream",
    buffer: file,
  });
  await page.getByRole("button", { name: "创建任务并上传" }).click();

  await expect(page.getByRole("heading", { name: "安全帽检测" })).toBeVisible();
  await expect(page.getByText("detection.yolov8").last()).toBeVisible();
  await expect(page.getByText("640 × 384", { exact: true })).toBeVisible();
  await expect(page.getByText("448 × 256", { exact: true })).toBeVisible();
  const storedImportIds = await page.evaluate((key) => localStorage.getItem(key),
    `ovis_model_import_ids:${deviceInfo.device_id}`,
  );
  expect(storedImportIds).toBeNull();
});

test("shows an active custom detector as the single object detection pipeline", async ({
  page,
}) => {
  const customConfig = structuredClone(currentConfig);
  customConfig.values.detection.object.enabled = true;
  customConfig.values.detection.object.model = {
    source: "custom",
    id: "018f1234abcd5678",
    runtime_model: "YOLOV8",
  };
  await mockConfigurationRead(page, customConfig, [
        {
          id: "018f1234abcd5678",
          status: "ready",
          importerId: "detection.yolov8",
          schemaVersion: 1,
          name: "安全帽检测",
          fileSize: 3_145_728,
          createdAt: 1_784_505_600,
          committedAt: 1_784_505_605,
          modelType: "YOLOV8",
          task: "object_detection",
          deployable: true,
          metadataSummary: { labelsCount: 2 },
          active: true,
          referenced: true,
          tensorSize: { width: 640, height: 384 },
          deployment: {
            threshold: 0.3,
            processingSize: { width: 448, height: 256 },
          },
        },
      ]);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByText("自定义 · 安全帽检测")).toBeVisible();
  const detection = page.getByRole("switch", { name: "启用目标检测" });
  await expect(detection).toBeChecked();
  await expect(detection).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "检测模型" })).toHaveValue(
    "018f1234abcd5678",
  );
  await expect(page.getByText("运行中", { exact: true })).toBeVisible();
});

test("uses config model source instead of the model-list active flag", async ({
  page,
}) => {
  await mockConfigurationRead(page, currentConfig, [
    {
      id: "018f1234abcd5678",
      status: "ready",
      importerId: "detection.yolov8",
      schemaVersion: 1,
      name: "安全帽检测",
      fileSize: 3_145_728,
      createdAt: 1_784_505_600,
      committedAt: 1_784_505_605,
      modelType: "YOLOV8",
      task: "object_detection",
      deployable: true,
      metadataSummary: { labelsCount: 2 },
      active: true,
      referenced: true,
      tensorSize: { width: 640, height: 640 },
      deployment: {
        threshold: 0.3,
        processingSize: { width: 448, height: 256 },
      },
    },
  ]);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.locator(".detection-runtime-summary")).toContainText(
    "内置 · 人员检测",
  );
  await expect(
    page.getByRole("switch", { name: "启用目标检测" }),
  ).toBeChecked();
});

test("blocks model activation while the configuration draft is unsaved", async ({
  page,
}) => {
  let activateRequests = 0;
  await mockConfigurationRead(page, currentConfig, [
    {
      id: "018f1234abcd5678",
      status: "ready",
      importerId: "detection.yolov8",
      schemaVersion: 1,
      name: "安全帽检测",
      fileSize: 3_145_728,
      createdAt: 1_784_505_600,
      committedAt: 1_784_505_605,
      modelType: "YOLOV8",
      task: "object_detection",
      deployable: true,
      metadataSummary: { labelsCount: 2 },
      active: false,
      referenced: false,
      tensorSize: { width: 640, height: 640 },
      deployment: {
        threshold: 0.3,
        processingSize: { width: 448, height: 256 },
      },
    },
  ]);
  await page.route("**/api/v1/models/018f1234abcd5678/activate", (route) => {
    activateRequests += 1;
    return fulfillJson(route, { task_id: 88 });
  });
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await page.getByRole("switch", { name: "OSD 总开关" }).click();
  await page.getByRole("button", { name: /模型管理/ }).click();
  await page.getByTitle("启用").click();

  await expect(
    page.getByText("当前配置存在未保存更改，请先保存或放弃更改。"),
  ).toBeVisible();
  expect(activateRequests).toBe(0);
});

test("probes the last successful device address first on the next scan", async ({
  page,
}) => {
  let recordingNextScan = false;
  let firstHostOnNextScan: string | null = null;
  await mockConfigurationRead(page);
  await page.route("**/api/v1/device/info", (route) => {
    const host = requestHost(route);
    if (recordingNextScan) firstHostOnNextScan ??= host;
    if (host === "192.168.44.1") return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByText("设备在线").first()).toBeVisible();
  await page.getByTitle("断开连接").click();

  recordingNextScan = true;
  await page.getByRole("button", { name: "重新搜索" }).click();
  await expect(page.getByText("发现 1 台 OVIS 设备")).toBeVisible();
  expect(firstHostOnNextScan).toBe("192.168.44.1");
});

test("renders AI capabilities and keeps TPU features mutually exclusive", async ({
  page,
}) => {
  await mockConfigurationRead(page);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  const person = page.getByRole("switch", { name: "启用目标检测" });
  const face = page.getByRole("switch", { name: "启用人脸检测" });
  const pose = page.getByRole("switch", { name: "启用人体姿态检测" });
  const tracking = page.getByRole("switch", { name: "启用单目标跟踪" });
  const motion = page.getByRole("switch", { name: "启用移动检测" });

  await expect(page.getByRole("combobox", { name: "检测模型" })).toHaveValue(
    "builtin.person_detection",
  );
  await expect(page.getByText("内置 · 人员检测")).toBeVisible();
  await expect(page.getByLabel("AI 输入帧尺寸 宽度").first()).toHaveValue("448");
  await expect(page.getByLabel("AI 输入帧尺寸 高度").first()).toHaveValue("256");
  await expect(page.getByText("YOLOv8 Pose")).toBeVisible();
  await expect(page.getByText(/FearTrack/).first()).toBeVisible();
  await expect(person).toBeChecked();

  page.once("dialog", (dialog) => dialog.accept());
  await pose.click();
  await expect(pose).toBeChecked();
  await expect(person).not.toBeChecked();
  await expect(face).not.toBeChecked();

  await tracking.click();
  await expect(tracking).toBeChecked();
  await expect(pose).toBeChecked();
  await expect(person).not.toBeChecked();
  await page.getByRole("combobox", { name: "默认目标获取方式" }).selectOption("fastsam");
  await expect(page.getByRole("combobox", { name: "默认目标获取方式" })).toHaveValue(
    "fastsam",
  );

  await motion.click();
  await expect(motion).toBeChecked();
  await expect(tracking).toBeChecked();
  await expect(page.getByText("有未应用的修改")).toBeVisible();
});

test("migrates the legacy combined feature into independent DET and TRACK controls", async ({
  page,
}) => {
  const legacyConfig = structuredClone(currentConfig);
  legacyConfig.values.detection.object.enabled = false;
  legacyConfig.values.detection.object_tracking.enabled = true;
  await mockConfigurationRead(page, legacyConfig);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  const detection = page.getByRole("switch", { name: "启用目标检测" });
  const tracking = page.getByRole("switch", { name: "启用单目标跟踪" });
  await expect(detection).toBeChecked();
  await expect(tracking).toBeChecked();

  await detection.click();
  await expect(detection).not.toBeChecked();
  await expect(tracking).toBeChecked();
  await expect(
    page.getByRole("combobox", { name: "默认目标获取方式" }).locator(
      'option[value="detection"]',
    ),
  ).toBeDisabled();

  await detection.click();
  await tracking.click();
  await expect(detection).toBeChecked();
  await expect(tracking).not.toBeChecked();
});

test("saves DET and TRACK independently without writing the legacy field", async ({
  page,
}) => {
  const splitConfig = splitDetectionTrackingConfig();
  const validationPayloads: Array<Record<string, unknown>> = [];
  await mockConfigurationRead(page, splitConfig);
  await page.route("**/api/v1/config/validate", async (route) => {
    validationPayloads.push(await route.request().postDataJSON());
    return fulfillJson(route, {
      valid: false,
      errors: [{ field: "test", code: "TEST_STOP", message: "stop after capture" }],
      warnings: [],
      requires: [],
    });
  });
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await page.locator(".detection-panel").getByRole("slider").fill("0.61");
  await page.getByRole("switch", { name: "使用 Kalman 滤波" }).click();
  await page.getByRole("button", { name: "保存目标检测" }).click();
  await expect.poll(() => validationPayloads.length).toBe(1);

  const detectionPayload = validationPayloads[0] as {
    values: {
      detection: { object: { threshold: number }; object_tracking?: unknown };
      tracking: { single_object: { use_kalman: boolean } };
    };
  };
  expect(detectionPayload.values.detection.object.threshold).toBe(0.61);
  expect(detectionPayload.values.tracking.single_object.use_kalman).toBe(true);
  expect(detectionPayload.values.detection.object_tracking).toBeUndefined();

  await page.getByRole("button", { name: "保存单目标跟踪" }).click();
  await expect.poll(() => validationPayloads.length).toBe(2);
  const trackingPayload = validationPayloads[1] as typeof detectionPayload;
  expect(trackingPayload.values.detection.object.threshold).toBe(0.7);
  expect(trackingPayload.values.tracking.single_object.use_kalman).toBe(false);
  expect(trackingPayload.values.detection.object_tracking).toBeUndefined();
});

test("shows TRACK runtime state and clears only the active target", async ({
  page,
}) => {
  const splitConfig = splitDetectionTrackingConfig();
  let clearRequests = 0;
  await mockConfigurationRead(page, splitConfig);
  await page.route("**/api/v1/tracking/status", (route) =>
    fulfillJson(route, {
      enabled: true,
      state: "tracking",
      source: "detection",
      target_valid: true,
      score: 0.91,
      detection_paused: false,
      error: null,
    }),
  );
  await page.route("**/api/v1/tracking/target", (route) => {
    expect(route.request().method()).toBe("DELETE");
    clearRequests += 1;
    return fulfillJson(route, {
      enabled: true,
      state: "waiting_target",
      source: null,
      target_valid: false,
      score: null,
      detection_paused: false,
      error: null,
    });
  });
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByText("正在跟踪")).toBeVisible();
  await page.getByRole("button", { name: "清除当前目标" }).click();
  await expect(page.getByText("等待选择目标")).toBeVisible();
  expect(clearRequests).toBe(1);
  await expect(page.getByRole("switch", { name: "启用目标检测" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "启用单目标跟踪" })).toBeChecked();
});

test("keeps AI configuration usable when processing-size constraints are absent", async ({
  page,
}) => {
  const capabilitiesWithoutConstraints = structuredClone(configCapabilities);
  const objectCapability = capabilitiesWithoutConstraints.ai.features.find(
    (feature) => feature.id === "object",
  );
  if (objectCapability) {
    objectCapability.processing_size = { default: { width: 448, height: 256 } } as typeof objectCapability.processing_size;
  }
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, capabilitiesWithoutConstraints),
  );
  await page.route("**/api/v1/models/importers", (route) =>
    fulfillJson(route, modelImporterCatalog),
  );
  await page.route("**/api/v1/models", (route) =>
    fulfillJson(route, {
      models: [],
      storage: { totalBytes: 0, availableBytes: 0, reservedBytes: 2_097_152 },
    }),
  );
  await page.route("**/api/v1/config", (route) =>
    fulfillJson(route, currentConfig),
  );
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByRole("switch", { name: "启用目标检测" })).toBeVisible();
  await expect(page.locator(".processing-size-editor--readonly")).toContainText(
    "448 × 256",
  );
  await expect(page.locator(".configuration-page")).toBeVisible();
});

test("enforces schema 5 AI BNR exclusivity in the configuration draft", async ({
  page,
}) => {
  const capabilities = {
    ...structuredClone(configCapabilities),
    schema_version: 5,
    ai_isp: {
      bnr: {
        supported: true,
        apply_mode: "ipcamera_restart",
        required_main_fps: 30,
        exclusive_with: [
          "object",
          "face",
          "motion",
          "human_pose",
          "object_tracking",
        ],
      },
    },
  };
  const configuration = {
    ...structuredClone(currentConfig),
    values: {
      ...structuredClone(currentConfig.values),
      ai_isp: { bnr: { enabled: false } },
    },
  };

  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, capabilities),
  );
  await page.route("**/api/v1/config", (route) =>
    fulfillJson(route, configuration),
  );
  await page.route("**/api/v1/models/importers", (route) =>
    fulfillJson(route, modelImporterCatalog),
  );
  await page.route("**/api/v1/models", (route) =>
    fulfillJson(route, {
      models: [],
      storage: { totalBytes: 0, availableBytes: 0, reservedBytes: 0 },
    }),
  );
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  const bnr = page.getByRole("switch", { name: "启用 AI BNR" });
  const object = page.getByRole("switch", { name: "启用目标检测" });
  const tracking = page.getByRole("switch", { name: "启用单目标跟踪" });
  const mainFps = page
    .locator(".stream-panel")
    .filter({ hasText: "主码流" })
    .getByLabel("帧率");
  await expect(bnr).not.toBeChecked();
  await expect(object).toBeChecked();
  await tracking.click();
  await expect(tracking).toBeChecked();
  await mainFps.selectOption("60");
  await expect(bnr).toBeDisabled();
  await expect(page.getByText("请先将主码流设置为 30 FPS")).toBeVisible();
  await mainFps.selectOption("30");
  await expect(bnr).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await bnr.click();
  await expect(bnr).toBeChecked();
  await expect(object).not.toBeChecked();
  await expect(object).toBeDisabled();
  await expect(tracking).not.toBeChecked();
  await expect(tracking).toBeDisabled();
  await expect(page.getByRole("switch", { name: "启用移动检测" })).toBeDisabled();
  await mainFps.selectOption("60");
  await expect(bnr).not.toBeChecked();
  await expect(bnr).toBeDisabled();
});

test("renders output capabilities and disables only RTSP-dependent controls", async ({
  page,
}) => {
  await mockConfigurationRead(page);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  const rtsp = page.getByRole("radio", { name: "RTSP 输出" });
  const uvc = page.getByRole("radio", { name: "UVC USB 摄像头" });
  const subEnabled = page.getByRole("switch", { name: "启用子码流" });
  const mainStream = page.getByRole("region", { name: "主码流" });
  const subStream = page.getByRole("region", { name: "子码流" });

  await expect(uvc).toBeChecked();
  await expect(rtsp).not.toBeChecked();
  await expect(mainStream.getByRole("combobox", { name: "帧率" })).toBeEnabled();
  await expect(mainStream.getByRole("spinbutton", { name: "码率" })).toBeDisabled();
  await expect(subEnabled).toBeDisabled();

  await rtsp.click();
  await expect(rtsp).toBeChecked();
  await expect(uvc).not.toBeChecked();
  await expect(mainStream.getByRole("spinbutton", { name: "码率" })).toBeEnabled();
  await expect(subEnabled).toBeEnabled();

  await uvc.click();
  await expect(uvc).toBeChecked();
  await expect(rtsp).not.toBeChecked();
  await expect(mainStream.getByRole("combobox", { name: "帧率" })).toBeEnabled();
  await expect(mainStream.getByRole("spinbutton", { name: "码率" })).toBeDisabled();
  await expect(mainStream.getByRole("spinbutton", { name: "码率" })).toHaveValue(10000);
  await expect(subEnabled).toBeDisabled();
  await expect(subEnabled).toBeChecked();
  await expect(subStream.getByRole("combobox", { name: "帧率" })).toBeDisabled();
  await expect(subStream.getByRole("spinbutton", { name: "码率" })).toBeDisabled();
  await uvc.click();
  await expect(uvc).toBeChecked();
  await expect(rtsp).not.toBeChecked();
});

test("normalizes legacy invalid output states to UVC without auto-saving", async ({
  page,
}) => {
  const legacyConfig = structuredClone(currentConfig);
  legacyConfig.values.outputs.rtsp.enabled = true;
  legacyConfig.values.outputs.uvc.enabled = true;
  let putRequests = 0;
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config", (route) => {
    if (route.request().method() === "PUT") putRequests += 1;
    return fulfillJson(route, legacyConfig);
  });
  await page.route("**/api/v1/models/importers", (route) =>
    fulfillJson(route, modelImporterCatalog),
  );
  await page.route("**/api/v1/models", (route) =>
    fulfillJson(route, {
      models: [],
      storage: { totalBytes: 0, availableBytes: 0, reservedBytes: 0 },
    }),
  );
  await discoverSingleDevice(page);
  await page.getByRole("radio").first().click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(
    page.getByRole("radio", { name: "UVC USB 摄像头" }),
  ).toBeChecked();
  await expect(page.getByRole("radio", { name: "RTSP 输出" })).not.toBeChecked();
  await expect(page.getByText("有未应用的修改")).toBeVisible();
  expect(putRequests).toBe(0);
});

test("hides output switches omitted by device capabilities", async ({ page }) => {
  const limitedCapabilities = structuredClone(configCapabilities);
  limitedCapabilities.outputs.rtsp.supported = false;
  limitedCapabilities.outputs.uvc.supported = false;
  await discoverSingleDevice(page);
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, limitedCapabilities),
  );
  await page.route("**/api/v1/config", (route) =>
    fulfillJson(route, currentConfig),
  );
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByRole("radio", { name: "RTSP 输出" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "UVC USB 摄像头" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /输出服务/ })).toHaveCount(0);
});

test("hides AI controls omitted by device capabilities", async ({ page }) => {
  const limitedCapabilities = structuredClone(configCapabilities);
  limitedCapabilities.ai.features = [configCapabilities.ai.features[1]];
  limitedCapabilities.ai.motion_detection = false;
  await discoverSingleDevice(page);
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, limitedCapabilities),
  );
  await page.route("**/api/v1/config", (route) =>
    fulfillJson(route, currentConfig),
  );
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByRole("switch", { name: "启用人脸检测" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "启用目标检测" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "启用人体姿态检测" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "启用单目标跟踪" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "启用移动检测" })).toHaveCount(0);
});

test("resets the connected device IP only after explicit confirmation", async ({
  page,
}) => {
  await page.addInitScript((deviceId) => {
    localStorage.setItem("ovis-ncm-subnets", JSON.stringify({ [deviceId]: 42 }));
  }, deviceInfo.device_id);
  await mockConfigurationRead(page);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  let resetRequests = 0;
  await page.route("**/api/v1/device/network/reset", async (route) => {
    resetRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(await route.request().headerValue("content-type")).toBeNull();
    await route.fulfill({ status: 202, body: "" });
  });

  await page.getByRole("button", { name: "重置设备 IP" }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "重置这台设备的 IP 地址？",
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("未初始化 USB 设备");
  await page.screenshot({ path: "/tmp/ovis-network-reset-confirmation.png" });
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(confirmation).toHaveCount(0);
  expect(resetRequests).toBe(0);

  await page.getByRole("button", { name: "重置设备 IP" }).click();
  await confirmation.getByRole("button", { name: "重置并重启" }).click();

  await expect(page.getByRole("button", { name: "搜索设备" })).toBeVisible();
  await expect(page.getByText("设备配置", { exact: true })).toHaveCount(0);
  expect(resetRequests).toBe(1);
  const rememberedSubnet = await page.evaluate((deviceId) => {
    const stored = JSON.parse(localStorage.getItem("ovis-ncm-subnets") ?? "{}") as Record<string, number>;
    return stored[deviceId];
  }, deviceInfo.device_id);
  expect(rememberedSubnet).toBeUndefined();
});

test("keeps the device IP reset confirmation inside a mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConfigurationRead(page);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "重置设备 IP" }).click();

  const confirmation = page.getByRole("alertdialog", {
    name: "重置这台设备的 IP 地址？",
  });
  await expect(confirmation).toBeVisible();
  const bounds = await confirmation.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "/tmp/ovis-network-reset-confirmation-mobile.png",
    fullPage: true,
  });
});

test(RESPONSIVE_CONFIG_TEST_TITLE, async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await mockConfigurationRead(page);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  const workspace = page.locator(".workspace-panel--configuration");
  const editor = page.locator(".configuration-editor");
  const dashboard = page.getByRole("complementary", {
    name: "Connected device dashboard",
  });
  const sectionMenu = page.getByRole("navigation", {
    name: "Configuration sections",
  });

  await expect(workspace).toBeVisible();
  await expect(dashboard).toBeVisible();
  await expect(sectionMenu).toBeVisible();
  await expect(dashboard.locator(".device-dashboard__meta dd").nth(1)).toHaveText(
    "192.168.42.1",
  );
  await expect(page.getByRole("button", { name: "01 Video Streams" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  const workspaceBounds = await workspace.boundingBox();
  const editorBounds = await editor.boundingBox();
  const dashboardBounds = await dashboard.boundingBox();
  const viewport = page.viewportSize();
  expect(workspaceBounds?.width).toBeGreaterThan(1700);
  expect(workspaceBounds?.height).toBeGreaterThan(1300);
  expect(dashboardBounds?.width).toBeGreaterThanOrEqual(380);
  expect(workspaceBounds?.x).toBeCloseTo(0, 0);
  expect(workspaceBounds?.width).toBeCloseTo(viewport?.width ?? 0, 0);

  const menuBounds = await sectionMenu.boundingBox();
  expect(dashboardBounds?.x).toBeCloseTo(workspaceBounds?.x ?? 0, 0);
  expect(menuBounds?.x).toBeGreaterThan(dashboardBounds?.x ?? 0);
  expect(editorBounds?.x).toBeGreaterThan(menuBounds?.x ?? 0);
  expect(dashboardBounds?.height).toBeGreaterThan(
    (workspaceBounds?.height ?? 0) - 3,
  );
  const overflow = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: document.documentElement.clientHeight,
    editorOverflowY: getComputedStyle(
      document.querySelector(".configuration-editor")!,
    ).overflowY,
  }));
  expect(overflow.documentHeight).toBe(overflow.viewportHeight);
  expect(overflow.editorOverflowY).toBe("auto");

  await page.screenshot({ path: "/tmp/ovis-config-2k.png", fullPage: true });
});

test("edits, validates, saves, applies, and polls configuration", async ({
  page,
}) => {
  let savedValues = structuredClone(currentConfig.values);
  Object.assign(savedValues.video.main, {
    sns_type: "OV_OS08A20_MIPI_8M_30FPS_12BIT",
    VTS: 2250,
    sensor_mode: "30fps",
  });
  let activeRevision = currentConfig.revision;
  let validatePayload: Record<string, unknown> | null = null;
  let savePayload: Record<string, unknown> | null = null;
  let applyPayload: Record<string, unknown> | null = null;
  let taskRequests = 0;
  let putRequests = 0;
  let applyStarted = false;
  let reconnectRequests = 0;

  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config/validate", async (route) => {
    validatePayload = await route.request().postDataJSON();
    return fulfillJson(route, {
      valid: true,
      errors: [],
      warnings: [
        {
          field: "outputs.uvc.enabled",
          code: "USB_RECONNECT",
          message: "UVC 变更会短暂中断 USB 连接",
        },
      ],
      requires: ["ipcamera_restart", "management_reconnect"],
    });
  });
  await page.route("**/api/v1/config/apply", async (route) => {
    applyPayload = await route.request().postDataJSON();
    applyStarted = true;
    return fulfillJson(route, { task_id: 12 });
  });
  await page.route("**/api/v1/tasks/12", (route) => {
    taskRequests += 1;
    return fulfillJson(route, {
      id: 12,
      state: taskRequests === 1 ? "running" : "succeeded",
      stage: taskRequests === 1 ? "restarting_ipcamera" : "completed",
      progress: taskRequests === 1 ? 60 : 100,
      message: taskRequests === 1 ? "正在应用配置" : "配置应用成功",
    });
  });
  await page.route("**/api/v1/config", async (route) => {
    if (route.request().method() === "PUT") {
      putRequests += 1;
      savePayload = await route.request().postDataJSON();
      savedValues = structuredClone(
        (savePayload as { values: typeof currentConfig.values }).values,
      );
      activeRevision = "b929d204";
      return fulfillJson(route, {
        saved: true,
        revision: activeRevision,
        restart_required: true,
      });
    }
    return fulfillJson(route, { revision: activeRevision, values: savedValues });
  });

  await discoverSingleDevice(page, async (route) => {
    if (requestHost(route) !== "192.168.42.1") {
      return route.abort("connectionrefused");
    }
    if (!applyStarted) return fulfillJson(route, deviceInfo);
    reconnectRequests += 1;
    if (reconnectRequests <= 2) return route.abort("connectionrefused");
    return fulfillJson(route, deviceInfo);
  });
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  const mainStream = page.getByRole("region", { name: "主码流" });
  await expect(mainStream).toBeVisible();
  const mainFps = mainStream.getByRole("combobox", { name: "帧率" });
  const subFps = page
    .getByRole("region", { name: "子码流" })
    .getByRole("combobox", { name: "帧率" });
  await expect(mainFps.locator('option[value="60"]')).toHaveCount(1);
  await expect(subFps.locator('option[value="60"]')).toHaveCount(0);

  await mainFps.selectOption("60");
  await page.getByRole("switch", { name: "OSD 总开关" }).click();
  const rtspMode = page.getByRole("radio", { name: "RTSP 输出" });
  const uvcMode = page.getByRole("radio", { name: "UVC USB 摄像头" });
  await expect(uvcMode).toBeChecked();
  await expect(rtspMode).not.toBeChecked();
  await rtspMode.click();
  await expect(rtspMode).toBeChecked();
  await expect(uvcMode).not.toBeChecked();
  await expect(page.getByText("有未应用的修改")).toBeVisible();
  const saveButton = page.getByRole("button", { name: "应用配置" });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();

  const applyConfirmation = page.getByRole("alertdialog", {
    name: "确认应用这些配置？",
  });
  await expect(applyConfirmation).toBeVisible();
  await expect(applyConfirmation).toContainText(
    "USB 连接和管理网络可能短暂重连",
  );
  await expect(applyConfirmation).toContainText("UVC 变更会短暂中断 USB 连接");
  expect(savePayload).toBeNull();
  await expect(uvcMode).toBeDisabled();
  await applyConfirmation.getByRole("button", { name: "确认并应用" }).click();

  await expect(page.getByText("配置已保存，视频服务正在重启").first()).toBeVisible();
  await expect(page.getByTitle("重新搜索")).toBeDisabled();
  await expect(page.getByRole("button", { name: "恢复默认" })).toBeDisabled();
  const pendingApplication = await page.evaluate(() =>
    JSON.parse(
      sessionStorage.getItem("ovis_pending_config_application") ?? "null",
    ),
  );
  expect(pendingApplication).toMatchObject({
    device_id: deviceInfo.device_id,
    api_base_url: "http://192.168.42.1:8080/api/v1",
    task_id: 12,
    target_revision: "b929d204",
  });
  await expect(page.getByText("设备正在重新连接")).toBeVisible();
  await expect(page.getByText("设备重启中").first()).toBeVisible();
  await expect(page.getByText("等待设备确认")).toBeVisible();
  await expect(page.getByText("无法访问所选设备")).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/ovis-config-reconnecting-desktop.png",
    fullPage: true,
  });
  await expect(page.getByText("配置已应用")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("配置已同步")).toBeVisible();
  await expect(rtspMode).toBeChecked();
  await expect(uvcMode).not.toBeChecked();
  expect(putRequests).toBe(1);
  expect(taskRequests).toBe(2);
  expect(reconnectRequests).toBe(3);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("ovis_pending_config_application"),
    ),
  ).toBeNull();
  expect(validatePayload).toMatchObject({
    revision: "a81f36c2",
    values: {
      video: {
        main: {
          profile: "1080p",
          fps: 60,
          bitrate_kbps: 10000,
        },
      },
      overlay: { enabled: false },
      outputs: {
        rtsp: { enabled: true },
        uvc: { enabled: false },
      },
      detection: {
        object: {
          enabled: true,
          threshold: 0.7,
          processing_size: { width: 448, height: 256 },
          model: "builtin.person_detection",
        },
      },
    },
  });
  expect(
    (validatePayload as { values: typeof currentConfig.values }).values.video.main,
  ).toEqual({
    profile: "1080p",
    fps: 60,
    bitrate_kbps: 10000,
  });
  expect(JSON.stringify(validatePayload)).not.toMatch(
    /sns_type|vts|sensor(?:_|\s*)mode/i,
  );
  expect(savePayload).toEqual(validatePayload);
  expect(applyPayload).toEqual({ revision: "b929d204" });
});

test("searches the address pool and reconnects only the original device id", async ({
  page,
}) => {
  let applyStarted = false;
  let activeRevision = currentConfig.revision;
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config/validate", (route) =>
    fulfillJson(route, { valid: true, errors: [], warnings: [], requires: [] }),
  );
  await page.route("**/api/v1/config/apply", (route) => {
    applyStarted = true;
    return fulfillJson(route, { task_id: 28 });
  });
  await page.route("**/api/v1/tasks/28", (route) =>
    fulfillJson(route, {
      id: 28,
      state: "succeeded",
      progress: 100,
      message: "配置应用成功",
    }),
  );
  await page.route("**/api/v1/config", (route) => {
    if (route.request().method() === "PUT") {
      activeRevision = "moved-revision";
      return fulfillJson(route, {
        saved: true,
        revision: activeRevision,
        restart_required: true,
      });
    }
    return fulfillJson(route, { revision: activeRevision, values: currentConfig.values });
  });

  await discoverSingleDevice(page, async (route) => {
    const host = requestHost(route);
    if (!applyStarted) {
      return host === "192.168.42.1"
        ? fulfillJson(route, deviceInfo)
        : route.abort("connectionrefused");
    }
    if (host === "192.168.43.1") return fulfillJson(route, secondDeviceInfo);
    if (host === "192.168.44.1") return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("region", { name: "主码流" }).getByRole("spinbutton").fill("9000");
  await page.getByRole("button", { name: "应用配置" }).click();

  await expect(page.getByText("设备正在重新连接")).toBeVisible();
  await expect(page.getByText("配置已应用")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("192.168.44.1", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OVIS Camera B" })).toHaveCount(0);
});

test("resumes a pending application after refresh and accepts a missing task", async ({
  page,
}) => {
  await page.addInitScript(
    ({ info }) => {
      sessionStorage.setItem(
        "ovis_pending_config_application",
        JSON.stringify({
          device_id: info.device_id,
          api_base_url: "http://192.168.42.1:8080/api/v1",
          task_id: 31,
          target_revision: "resume-revision",
          started_at: Date.now(),
        }),
      );
    },
    { info: deviceInfo },
  );
  await page.route("**/api/v1/device/info", async (route) => {
    if (requestHost(route) !== "192.168.42.1") {
      return route.abort("connectionrefused");
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return fulfillJson(route, deviceInfo);
  });
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/tasks/31", (route) => route.fulfill({ status: 404 }));
  await page.route("**/api/v1/config", (route) =>
    fulfillJson(route, {
      revision: "resume-revision",
      values: currentConfig.values,
    }),
  );

  await page.goto("./");
  await expect(page.getByText("正在恢复设备连接")).toBeVisible();
  await expect(page.getByText("配置已应用")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("heading", { name: "OVIS Camera" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("ovis_pending_config_application"),
    ),
  ).toBeNull();
});

test("fails verification when the target revision is not active", async ({
  page,
}) => {
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config/validate", (route) =>
    fulfillJson(route, { valid: true, errors: [], warnings: [], requires: [] }),
  );
  await page.route("**/api/v1/config/apply", (route) =>
    fulfillJson(route, { task_id: 38 }),
  );
  await page.route("**/api/v1/tasks/38", (route) => route.fulfill({ status: 404 }));
  await page.route("**/api/v1/config", (route) => {
    if (route.request().method() === "PUT") {
      return fulfillJson(route, {
        saved: true,
        revision: "target-not-active",
        restart_required: true,
      });
    }
    return fulfillJson(route, currentConfig);
  });

  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("region", { name: "主码流" }).getByRole("spinbutton").fill("9000");
  await page.getByRole("button", { name: "应用配置" }).click();

  await expect(page.getByText("应用失败，已恢复原配置").first()).toBeVisible({
    timeout: 6_000,
  });
});

test("shows server validation errors without saving", async ({ page }) => {
  let saveRequests = 0;
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config/validate", (route) =>
    fulfillJson(route, {
      valid: false,
      errors: [
        {
          field: "video.main.bitrate_kbps",
          code: "OUT_OF_RANGE",
          message: "主码流码率超出允许范围",
        },
        {
          field: "detection",
          code: "AI_FEATURE_CONFLICT",
          message: "人员、人脸、人体姿态和目标跟踪最多只能启用一项",
        },
      ],
      warnings: [],
      requires: [],
    }),
  );
  await page.route("**/api/v1/config", (route) => {
    if (route.request().method() === "PUT") saveRequests += 1;
    return fulfillJson(route, currentConfig);
  });

  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  const mainStream = page.getByRole("region", { name: "主码流" });
  await mainStream.getByRole("spinbutton").fill("12000");
  await page.getByRole("button", { name: "应用配置" }).click();

  await expect(page.getByText("配置校验未通过")).toBeVisible();
  await expect(page.getByText("码率范围为 512-15000 Kbps")).toBeVisible();
  await expect(
    page.getByText("人员、人脸、人体姿态和目标跟踪最多只能启用一项"),
  ).toBeVisible();
  expect(saveRequests).toBe(0);
  await expect(page.getByText("有未应用的修改")).toBeVisible();
});

test("reloads device configuration after a revision conflict", async ({ page }) => {
  let configReads = 0;
  let saveRequests = 0;
  const reloadedConfig = structuredClone(currentConfig);
  reloadedConfig.revision = "server-new-revision";
  reloadedConfig.values.video.main.bitrate_kbps = 7777;

  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config/validate", (route) =>
    route.fulfill({ status: 409, body: "" }),
  );
  await page.route("**/api/v1/config", (route) => {
    if (route.request().method() === "PUT") {
      saveRequests += 1;
      return fulfillJson(route, { saved: false });
    }
    configReads += 1;
    return fulfillJson(route, configReads === 1 ? currentConfig : reloadedConfig);
  });

  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  const bitrate = page
    .getByRole("region", { name: "主码流" })
    .getByRole("spinbutton", { name: "码率" });
  await bitrate.fill("9000");
  await page.getByRole("button", { name: "应用配置" }).click();

  await expect(
    page.getByText("配置已变化，已重新加载板端最新配置。"),
  ).toBeVisible();
  await expect(page.getByText("配置已同步")).toBeVisible();
  await expect(bitrate).toHaveValue("7777");
  expect(configReads).toBe(2);
  expect(saveRequests).toBe(0);
});

test("reports automatic rollback when apply fails", async ({ page }) => {
  let taskFailed = false;
  let postFailureConfigReads = 0;
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config/validate", (route) =>
    fulfillJson(route, { valid: true, errors: [], warnings: [], requires: [] }),
  );
  await page.route("**/api/v1/config/apply", (route) =>
    fulfillJson(route, { task_id: 18 }),
  );
  await page.route("**/api/v1/tasks/18", (route) => {
    taskFailed = true;
    return fulfillJson(route, {
      id: 18,
      state: "failed",
      rolled_back: true,
      message: "新配置启动失败，已恢复原配置",
    });
  });
  await page.route("**/api/v1/config", (route) => {
    if (route.request().method() === "PUT") {
      return fulfillJson(route, {
        saved: true,
        revision: "failed-revision",
        restart_required: true,
      });
    }
    if (taskFailed) postFailureConfigReads += 1;
    return fulfillJson(route, currentConfig);
  });

  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("region", { name: "主码流" }).getByRole("spinbutton").fill("9000");
  await page.getByRole("button", { name: "应用配置" }).click();

  await expect(page.getByText("新配置启动失败，已恢复原配置")).toBeVisible();
  await expect(page.getByText("应用失败，已恢复原配置。")).toBeVisible();
  expect(postFailureConfigReads).toBe(1);
});

test("restores defaults and reloads the resulting configuration", async ({
  page,
}) => {
  const resetValues = structuredClone(currentConfig.values);
  resetValues.overlay.enabled = false;
  let resetCompleted = false;
  await page.route("**/api/v1/config/capabilities", (route) =>
    fulfillJson(route, configCapabilities),
  );
  await page.route("**/api/v1/config/reset", (route) => {
    resetCompleted = true;
    return fulfillJson(route, { task_id: 22 });
  });
  await page.route("**/api/v1/tasks/22", (route) =>
    fulfillJson(route, {
      id: 22,
      state: "succeeded",
      progress: 100,
      message: "已恢复默认配置",
    }),
  );
  await page.route("**/api/v1/config", (route) =>
    fulfillJson(
      route,
      resetCompleted
        ? { revision: "defaults-1", values: resetValues }
        : currentConfig,
    ),
  );

  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "恢复默认" }).click();
  await expect(page.getByText("恢复设备默认配置？")).toBeVisible();
  await page.getByRole("button", { name: "确认恢复" }).click();

  await expect(page.getByText("已恢复默认配置")).toBeVisible();
  await expect(page.getByRole("switch", { name: "OSD 总开关" })).not.toBeChecked();
  await expect(page.getByText("REVISION defaults-1")).toBeVisible();
});

test("supports cancelling a scan and rescanning after an empty result", async ({
  page,
}) => {
  let returnDevice = false;
  let delayRequests = true;
  await page.route("**/api/v1/device/info", async (route) => {
    if (delayRequests) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (returnDevice && requestHost(route) === "192.168.42.1") {
      return fulfillJson(route, deviceInfo);
    }
    return fulfillJson(route, { ...deviceInfo, protocol: "not-ovis" });
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await expect(page.getByText("正在搜索 OVIS 设备")).toBeVisible();
  await page.getByRole("button", { name: "取消搜索" }).click();
  await expect(page.getByRole("button", { name: "搜索设备" })).toBeVisible();

  delayRequests = false;
  await page.getByRole("button", { name: "搜索设备" }).click();
  await expect(page.getByText("未找到 OVIS 设备")).toBeVisible();
  returnDevice = true;
  await page.getByRole("button", { name: "重新搜索" }).click();
  await expect(page.getByText("发现 1 台 OVIS 设备")).toBeVisible();
});

test("shows a remembered Linux device immediately and can connect while the remaining scan is cancelled", async ({
  page,
}) => {
  await page.addInitScript((deviceId) => {
    localStorage.setItem("ovis-ncm-subnets", JSON.stringify({ [deviceId]: 23 }));
  }, deviceInfo.device_id);
  await mockConfigurationRead(page);
  let targetRequests = 0;
  await page.route("**/api/v1/device/info", async (route) => {
    if (requestHost(route) === "192.168.23.1") {
      targetRequests += 1;
      return fulfillJson(route, deviceInfo);
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    return route.abort("connectionrefused").catch(() => undefined);
  });

  await page.goto("./");
  const startedAt = Date.now();
  await page.getByRole("button", { name: "搜索设备" }).click();
  const result = page.getByRole("radio", { name: /OVIS Camera/ });
  await expect(result).toBeVisible({ timeout: 700 });
  expect(Date.now() - startedAt).toBeLessThan(850);
  await expect(page.getByText("正在后台继续搜索其它网段")).toBeVisible();

  await result.click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByText("设备在线").first()).toBeVisible();
  expect(targetRequests).toBe(2);
});

test("retries a selected device GET after Failed to fetch and then connects", async ({
  page,
}) => {
  await page.addInitScript((deviceId) => {
    localStorage.setItem("ovis-ncm-subnets", JSON.stringify({ [deviceId]: 23 }));
  }, deviceInfo.device_id);
  await mockConfigurationRead(page);
  let targetRequests = 0;
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) !== "192.168.23.1") {
      return route.abort("connectionrefused");
    }
    targetRequests += 1;
    if (targetRequests === 2) return route.abort("connectionrefused");
    return fulfillJson(route, deviceInfo);
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await page.getByRole("radio", { name: /OVIS Camera/ }).click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByText("设备在线").first()).toBeVisible();
  expect(targetRequests).toBe(3);
});

test("keeps a discovered device after three connection failures and retries only its endpoint", async ({
  page,
}) => {
  await page.addInitScript((deviceId) => {
    localStorage.setItem("ovis-ncm-subnets", JSON.stringify({ [deviceId]: 23 }));
  }, deviceInfo.device_id);
  let targetRequests = 0;
  let allowTarget = true;
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) !== "192.168.23.1") {
      return route.abort("connectionrefused");
    }
    targetRequests += 1;
    if (allowTarget) return fulfillJson(route, deviceInfo);
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  const result = page.getByRole("radio", { name: /OVIS Camera/ });
  await result.click();
  allowTarget = false;
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByText("无法连接 192.168.23.1:8080")).toBeVisible();
  await expect(result).toBeVisible();
  await expect(result).toContainText("离线");
  expect(targetRequests).toBe(4);

  await page.getByRole("button", { name: "重试连接" }).first().click();
  await expect(page.getByText("无法连接 192.168.23.1:8080")).toBeVisible();
  await expect(page.getByText("初始化 OVIS 设备")).toHaveCount(0);
  expect(targetRequests).toBe(7);
});

test("does not retry a failed non-idempotent device write", async ({ page }) => {
  await mockConfigurationRead(page);
  await page.route("**/api/v1/config/validate", (route) =>
    fulfillJson(route, { valid: true, errors: [], warnings: [], requires: [] }),
  );
  let putRequests = 0;
  await page.route("**/api/v1/config", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    putRequests += 1;
    return route.abort("connectionrefused");
  });
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("switch", { name: "OSD 总开关" }).click();
  await page.getByRole("button", { name: "应用配置" }).click();

  await expect.poll(() => putRequests).toBe(1);
  await page.waitForTimeout(1_200);
  expect(putRequests).toBe(1);
});

test("adds the local address-space hint on Linux Chromium requests", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const calls: Array<{ url: string; targetAddressSpace?: string }> = [];
    Object.defineProperty(window, "__ovisLocalFetchCalls", {
      configurable: true,
      value: calls,
    });
    window.fetch = (input, init) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        targetAddressSpace: (init as RequestInit & { targetAddressSpace?: string })
          ?.targetAddressSpace,
      });
      return originalFetch(input, init);
    };
  });
  await mockConfigurationRead(page);
  await page.route("**/api/v1/device/info", (route) =>
    requestHost(route) === "192.168.42.1"
      ? fulfillJson(route, deviceInfo)
      : route.abort("connectionrefused"),
  );

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await page.getByRole("radio", { name: /OVIS Camera/ }).click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByText("设备在线").first()).toBeVisible();
  const calls = await page.evaluate(() =>
    (window as unknown as {
      __ovisLocalFetchCalls: Array<{ url: string; targetAddressSpace?: string }>;
    }).__ovisLocalFetchCalls,
  );
  expect(
    calls.some(
      (call) =>
        call.url.includes("192.168.42.1:8080") &&
        call.targetAddressSpace === "local",
    ),
  ).toBe(true);
  expect(
    calls.some(
      (call) =>
        call.url.includes("/config/capabilities") &&
        call.targetAddressSpace === "local",
    ),
  ).toBe(true);
});

test("omits the local address-space hint on macOS Chromium requests", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    });
    const originalFetch = window.fetch.bind(window);
    const calls: Array<{ url: string; targetAddressSpace?: string }> = [];
    Object.defineProperty(window, "__ovisLocalFetchCalls", {
      configurable: true,
      value: calls,
    });
    window.fetch = (input, init) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        targetAddressSpace: (init as RequestInit & { targetAddressSpace?: string })
          ?.targetAddressSpace,
      });
      return originalFetch(input, init);
    };
  });
  await page.route("**/api/v1/device/info", (route) =>
    requestHost(route) === "192.168.42.1"
      ? fulfillJson(route, deviceInfo)
      : route.abort("connectionrefused"),
  );

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await expect(page.getByRole("radio", { name: /OVIS Camera/ })).toBeVisible();
  const calls = await page.evaluate(() =>
    (window as unknown as {
      __ovisLocalFetchCalls: Array<{ url: string; targetAddressSpace?: string }>;
    }).__ovisLocalFetchCalls,
  );
  expect(
    calls
      .filter((call) => call.url.includes("192.168.42.1:8080"))
      .every((call) => call.targetAddressSpace === undefined),
  ).toBe(true);
});

test("rejects a device whose identity changes before connection", async ({
  page,
}) => {
  let selectedHostRequests = 0;
  await page.route("**/api/v1/device/info", (route) => {
    if (requestHost(route) !== "192.168.42.1") {
      return route.abort("connectionrefused");
    }
    selectedHostRequests += 1;
    return fulfillJson(
      route,
      selectedHostRequests === 1 ? deviceInfo : secondDeviceInfo,
    );
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByText("无法连接 192.168.42.1:8080")).toBeVisible();
  await expect(page.getByText("所选地址对应的设备已更换，请重新搜索并确认设备。")).toBeVisible();
  await expect(page.getByRole("radio", { name: /OVIS Camera/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试连接" }).first()).toBeVisible();
});

test("ignores incompatible responses during discovery", async ({ page }) => {
  await page.route("**/api/v1/device/info", (route) => {
    return fulfillJson(route, { ...deviceInfo, api_version: 2 });
  });
  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();

  await expect(page.getByText("未找到 OVIS 设备")).toBeVisible();
  await expect(page.getByText("API 版本不兼容")).toHaveCount(0);
});

test("heartbeats only the selected device and stops after two failures", async ({
  page,
}) => {
  await mockConfigurationRead(page);
  const requestsByHost = new Map<string, number>();
  await page.route("**/api/v1/device/info", (route) => {
    const host = requestHost(route);
    const count = (requestsByHost.get(host) ?? 0) + 1;
    requestsByHost.set(host, count);

    if (host === "192.168.42.1" && count <= 2) {
      return fulfillJson(route, deviceInfo);
    }
    return route.abort("connectionrefused");
  });

  await page.goto("./");
  await page.getByRole("button", { name: "搜索设备" }).click();
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByText("设备在线").first()).toBeVisible();
  await expect(page.getByText("设备连接已中断")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("操作异常")).toBeVisible();
  expect(requestsByHost.get("192.168.42.1")).toBe(8);
  expect(requestsByHost.get("192.168.43.1")).toBe(1);
});

test("keeps idle and result workspaces within a mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/device/info", (route) => {
    const host = requestHost(route);
    if (host === "192.168.42.1") return fulfillJson(route, deviceInfo);
    if (host === "192.168.43.1") return fulfillJson(route, secondDeviceInfo);
    return route.abort("connectionrefused");
  });
  await page.goto("./");

  await expect(page.getByRole("button", { name: "搜索设备" })).toBeVisible();
  const model = page.getByRole("img", { name: "OVIS 相机模组 3D 展示" });
  await expect(model).toHaveAttribute("data-model-status", "ready", {
    timeout: 25_000,
  });
  const canvasSignal = await readCanvasSignal(page);
  expect(canvasSignal.visiblePixels).toBeGreaterThan(
    canvasSignal.width * canvasSignal.height * 0.02,
  );

  await page.getByRole("button", { name: "搜索设备" }).click();
  await expect(page.getByText("发现 2 台 OVIS 设备")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.contentWidth).toBe(dimensions.viewportWidth);
  await page.screenshot({ path: "/tmp/ovis-results-mobile.png", fullPage: true });
});

test("keeps the configuration workspace usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConfigurationRead(page);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "连接", exact: true }).click();

  await expect(page.getByRole("heading", { name: "设备配置", level: 1 })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "设备配置", level: 3 })).toBeVisible();
  await expect(page.getByRole("region", { name: "主码流" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "启用目标检测" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.contentWidth).toBe(dimensions.viewportWidth);
  await page.screenshot({ path: "/tmp/ovis-config-mobile.png", fullPage: true });
});

test(ENGLISH_MOBILE_CONFIG_TEST_TITLE, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConfigurationRead(page);
  await discoverSingleDevice(page);
  await page.getByRole("radio").click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Device Configuration", level: 1 }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Configuration", level: 3 }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Main Stream" })).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Enable object detection" }),
  ).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.contentWidth).toBe(dimensions.viewportWidth);
  await page.screenshot({
    path: "/tmp/ovis-config-mobile-en.png",
    fullPage: true,
  });
});
