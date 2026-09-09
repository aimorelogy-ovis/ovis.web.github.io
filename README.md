# OVIS Workspace

OVIS Workspace 设备管理网页，提供受管环境检测、设备发现、连接、断线检测和设备配置。

## 本地开发

```bash
npm install
npm run dev
```

本地开发可在 `.env.local` 设置 `VITE_WORKSPACE_POLICY_MOCK=ready` 跳过真实企业策略，
也可使用 `missing`、`outdated`、`unsupported` 或 `error` 检查门禁状态。该 mock 仅在
Vite 开发模式生效；生产构建不提供环境变量或查询参数绕过。

应用启动时先通过 `navigator.managed.getManagedConfiguration(keys)` 或
`navigator.device.getManagedConfiguration(keys)` 检查受管 Workspace 策略。只有策略
版本、WebUSB VID/PID 和当前 Origin 全部匹配，才会挂载设备管理功能。该能力要求网站
由 `WebAppInstallForceList` 强制安装，并通过 `ManagedConfigurationPerOrigin` 配置。

“搜索设备”会同时扫描 `192.168.0.1` 至 `192.168.255.1` 的 Manager API，并通过
`navigator.usb.getDevices()` 读取已经授权的未初始化设备。两类设备按
`device_id` 合并显示；同一设备同时由网络和 WebUSB 发现时，以已初始化的网络设备
为准。设备搜索只进行策略授权后的静默枚举，不调用 `requestDevice()`，也不显示独立
USB 授权入口。没有插入设备时仍可正常进入 Workspace。

未初始化设备必须预先通过 Chrome 或 Edge 企业策略授权。策略名为
`WebUsbAllowDevicesForUrls`，值为：

```json
[
  {
    "devices": [{ "vendor_id": 13126, "product_id": 4110 }],
    "urls": ["https://ovis.aimorelogy.com"]
  }
]
```

Windows 使用 `REG_SZ`：

- Chrome: `HKLM\SOFTWARE\Policies\Google\Chrome\WebUsbAllowDevicesForUrls`
- Edge: `HKLM\SOFTWARE\Policies\Microsoft\Edge\WebUsbAllowDevicesForUrls`

macOS 使用 Managed Preferences：Chrome 域为 `com.google.Chrome`，Edge 域为
`com.microsoft.Edge`，键名均为 `WebUsbAllowDevicesForUrls`。配置需要通过
`.mobileconfig`、MDM 或 Managed Preferences 安装一次。Safari 不受支持。

策略参考：[Chrome Enterprise Policy](https://chromeenterprise.google/policies/#WebUsbAllowDevicesForUrls)、
[Microsoft Edge Policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/webusballowdevicesforurls)。

策略门禁不能使用 `getDevices().length` 判断策略是否安装。Windows 支持包下载后需要
用户运行安装器并确认 UAC；页面每 2 秒重新检测，并在策略生效后自动进入 Workspace。
不可变配置发布在 `/managed/ovis-workspace-policy-v1.json`，对应 `.sha256` 文件会在每次
构建前校验，内容变更必须创建新的策略版本文件。

门禁页为 Windows、Linux 和 macOS 提供独立下载入口，默认地址分别为
`/downloads/OVIS-Workspace-Setup-v1.exe`、`/downloads/OVIS-Workspace-Setup-v1.deb` 和
`/downloads/OVIS-Workspace-Setup-v1.mobileconfig`。部署时可通过
`VITE_WORKSPACE_SETUP_WINDOWS_URL`、`VITE_WORKSPACE_SETUP_LINUX_URL` 和
`VITE_WORKSPACE_SETUP_MACOS_URL` 覆盖；旧的 `VITE_WORKSPACE_SETUP_URL` 仍作为
Windows 地址兼容项。

安装器源码位于 `installer/`，三平台都写入相同的 Chrome/Edge 策略载荷。运行
`npm run build:installers` 可重新生成 `public/downloads` 中的发布文件和
`SHA256SUMS`；Windows 构建需要 NSIS `makensis`。当前 Windows EXE 未进行
Authenticode 签名，正式外部分发前应使用公司的代码签名证书签名。

未初始化设备进入独立初始化页面，用户填写 `192.168.X.1` 中的 `X`。网页先根据
已验证的网络设备检查网段占用，再单独探测目标地址，并通过 `navigator.locks`
避免多个页面同时分配相同网段。提交完成后每 2 秒轮询新地址，最长等待 90 秒，
只有返回相同 `device_id` 才进入现有设备配置页。

未配置设备使用 `PID 0x100E` 的独立 WebUSB 配置模式；保存后立即重新枚举为
`PID 0x100D` 的 `NCM + UVC` 运行设备。设备后续启动会直接恢复已保存地址，不再
加载 WebUSB 配置接口，也不再要求重复配置。网页在提交成功后把地址写入
`localStorage`，后续搜索会优先探测历史成功地址和上次连接地址。策略授权设备可由
`navigator.usb.getDevices()` 静默获取。

连接设备后，网页从选中设备的 `apiBaseUrl` 读取配置能力和当前配置，支持
视频码流、OSD 与智能检测参数的校验、保存、应用、任务轮询和恢复默认。
当前配置接口不携带登录或认证信息。

配置应用期间会把设备 ID、地址、任务 ID、目标 revision 和开始时间保存到
`sessionStorage`。设备重启断网后，网页只重连相同 `device_id`，并在 90 秒内
通过任务结果和配置 revision 确认应用或回滚；刷新页面不会中断该流程。

切换 UVC / RTSP 或校验接口要求 `usb_gadget_restart` 时，确认提示会明确说明
设备将重启。应用期间显示等待重启、自动重连状态并锁定配置操作，不会把重启前的
任务 `succeeded` 或已写入的 revision 当作完成，也不展示该任务的 100% 进度。
当前固件的任务记录仅保存在 Manager 内存中；网页等待该任务在重启后消失，再核对
原设备 ID 和目标 revision 后提示成功。因此即使刷新页面或错过短暂断网，也不会
提前结束等待。若固件以后持久化任务，需要同步调整重启确认协议。
仅重启视频服务和 OSD 热更新仍按原有任务结果确认，不额外等待整机重启。

## 构建

```bash
npm run build
```

Vite 和 GitHub Pages 部署均使用根路径 `/`，用于自定义域名
`ovis.aimorelogy.com`。仓库通过 GitHub Actions 发布，因此自定义域名应在
仓库的 `Settings > Pages > Custom domain` 中配置，而不是依赖仓库内的
`CNAME` 文件。
