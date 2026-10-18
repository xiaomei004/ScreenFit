# ScreenFit

把只有手机版、没有 PC 端的 App（竖屏短视频、小众应用等）投屏到电脑，并把它"适配"成适合桌面大屏观看的形态。

不是又一个投屏工具——投屏用 [scrcpy](https://github.com/Genymobile/scrcpy) 现成能力，ScreenFit 解决的是**布局适配**这一层。

## 三档适配策略

| 档位 | 做法 | 难度 | 兼容性 |
| --- | --- | --- | --- |
| L1 画面填充 | 竖屏画面居中，两侧用同屏模糊延展铺满全屏；也可裁切放大铺满 | 低 | 所有 App |
| L2 虚拟显示重排 | 在手机上开一块虚拟屏幕，App 在里面按窗口尺寸重新布局，往往触发横屏/平板版面 | 中 | 支持多窗口/自适应的 App |
| L3 系统级强制 | root 或特定机型下改机型、改 DPI、Hook 强制横屏 | 高 | 视设备而定 |

当前目标：**L1 + L2**，非 root、Android 14+、USB 直连。

## 架构

```
手机 --USB/ADB--> scrcpy-server --H.264--> 主进程(解码+控制) --> 渲染进程 --> 全屏窗口
                                                              └--> 布局适配引擎(L1/L2/L3)
```

- `src/main` Electron 主进程：ADB 管理、scrcpy 协议客户端、窗口管理
- `src/renderer` 渲染进程：WebCodecs 硬解、布局适配渲染、交互
- `src/shared` 两端共用的 IPC 类型定义

## 开发

```bash
npm install
npm run vendor:scrcpy   # 下载 scrcpy 发行版到 vendor/
npm run dev             # 构建并启动
npm run typecheck       # 类型检查
```

## 许可

MIT。依赖的 scrcpy-server 为 Apache-2.0，许可证见 `vendor/`。
