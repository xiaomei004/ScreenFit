# Spike 验证报告：投屏链路与布局重排

## 测试环境

| 项目 | 值 |
|---|---|
| 设备 | Redmi 25053RT47C (`39d68d32`) |
| 系统 | Android 16（SDK 36） |
| Root | 无 |
| 物理分辨率 | 1280x2772 @ 520dpi |
| scrcpy | v5.0.1 |
| 桌面 | Windows，d3d11va 硬解 |

## Spike A：USB 投屏链路 — ✅ 通过

```
scrcpy-server: 1 file pushed (733930 bytes)
[server] INFO: Device: [Xiaomi] Redmi 25053RT47C (Android 16)
INFO: Video decoding: d3d11va
INFO: Texture (D3D11VA): 592x1280
```

- server 部署、反向隧道、握手全部成功
- 硬解码走 d3d11va，无需软件解码
- 结论：**投屏本身零难度，直接用 scrcpy 即可**

## Spike B：虚拟显示重排（抖音）— ❌ 未触发重排

```
scrcpy --new-display=1920x1080/240 --start-app=com.ss.android.ugc.aweme
[server] INFO: New display: 1920x1080/240 (id=4)
INFO: Texture (D3D11VA): 1920x1088
```

虚拟屏确实以 1920 宽的横屏尺寸创建成功，视频流也按 1920x1088 编码。
但窗口内的实际内容：**抖音仍是竖屏 UI 居中，左右两侧黑色填充（letterbox）**。

见 `spike-b-douyin.png`。

## Spike C：强制忽略竖屏请求 — ❌ 无效

```
adb shell wm set-ignore-orientation-request -d 5 true
→ ignoreOrientationRequest true for displayId=5
```

把抖音冷启动到该虚拟屏后，画面**依然是竖屏内容 + 两侧黑边**（见 `spike-c-douyin.png`）。

**结论**：抖音的竖屏不是"向系统申请竖屏被成全"，而是**布局实现层面只写了竖屏**。
系统级强制手段改不了 App 自身的布局代码，这是 L2/L3 路线的硬边界。

## 对照：B站 — 同样保持竖屏信息流

`tv.danmaku.bili` 启动到虚拟屏后首页仍为竖屏信息流（见 `spike-b-bilibili.png`）。
信息流页本来就是竖屏设计，符合预期；真正的横屏差异需要进入播放页才体现，待后续验证。

## ⚠️ 关键阻塞项：MIUI 输入注入限制

```
[server] ERROR: Injecting input events requires the caller ... to have the INJECT_EVENTS permission.
[server] ERROR: Make sure you have enabled "USB debugging (Security Settings)" and then rebooted your device.
```

小米/红米设备上 scrcpy **无法注入点击、滑动、按键**，除非开发者选项里开启
「USB 调试（安全设置）」（MIUI 通常还要求登录小米账号，部分版本要求插 SIM 卡，且需重启）。

影响：投屏能看，但**电脑端无法控制手机**，键鼠映射功能全部失效，直到用户开启该开关。
这必须做成 onboarding 引导步骤。

## 对产品方向的结论

| 路线 | 结论 |
|---|---|
| L1 画面填充（模糊延展 / 裁切铺满） | ✅ 确定可行，应作为核心卖点 |
| L2 虚拟显示让 App 重排 | ⚠️ 仅对本身实现了大屏/横屏布局的 App 有效；抖音、短剧类锁竖屏 App 无效 |
| L3 系统级强制 | ❌ 未 root 下对布局写死竖屏的 App 无解 |
| 键鼠控制 | ⚠️ 受 MIUI 安全设置限制，需用户手动开启 |

**产品定位调整建议**：不承诺"让竖屏 App 变横屏"，而是承诺
"把手机画面高质量铺满电脑全屏 + 键鼠控制 + 对每个 App 记住最佳填充参数"。

## 附：本机验证命令

```bash
adb devices -l
adb shell getprop ro.build.version.release
scrcpy --new-display=1920x1080/240 --start-app=<包名>
adb shell wm set-ignore-orientation-request -d <displayId> true
node scripts/electron-run.mjs scripts/screenshot.mjs out.png   # SHOT_WINDOW=标题 截指定窗口
```
