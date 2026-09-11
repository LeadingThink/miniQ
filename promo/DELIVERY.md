# miniQ 宣传片交付说明

## 成品

- out/miniq-promo-final.mp4：78 秒，1080p，30 fps，H.264 / AAC，无旁白。
- ../docs/miniq-product-report.md：定位、能力、对比、远程工作流和模型协议说明。
- out/live/：真实双端录制、设置截图、完成截图及事件记录。

## 片段来源

0–38 秒为功能动效，画面右上标明“功能动效演示”，不作为这些功能的端到端测试证据。
38–55 秒使用同次真实双页面逐帧录制：桌面等待审批，移动端允许一次，创建发布摘要，移动端发送读取续接指令。
55–58 秒展示同一会话稍后采集的真实完成截图；原录制结束时模型仍在生成，不冒充连续实时完成。
58–72 秒模型协议说明，右侧是真实设置面板中四种协议的选择操作实录；未保存更改，不代表逐个调用了所有模型。
72–78 秒品牌收尾。

远程录制使用隔离本地 daemon、真实 relay、同 Key 身份和真实模型请求。移动端为 Chrome 手机视口，不是实体手机。仅重定向 relay 地址到本机，未伪造产品协议消息。成品不展示 API Key。连接公网、实体手机和所有模型供应商没有在本次验证。

## 重建

在仓库根目录安装 promo/package.json 中的依赖；需要 Chrome、ffmpeg、Python 3 与 NumPy。保留现有 out/miniq-promo.mp4 作为动效源，以及 out/live 录制素材。

```sh
python3 promo/audio.py
node promo/final-render.mjs
```

首次生成动效源可参考 build.sh；该脚本是旧版动效构建入口，最终成片以 final-render.mjs 为准。重新实录需自行准备隔离运行环境；live-take.mjs 针对本次已有会话和待审批状态，不是可无条件重复的集成测试。

音乐及音效由 audio.py 合成，无配音或外部商用曲目。证据 transcript.json 记录的是录制结束时的状态，不是最终任务完成状态；completed-desktop.png 和 completed-mobile.png 为后续完成证据。

## 交付检查

最终音视频均为 78 秒，H.264 1920×1080 / 30 fps、AAC 双声道。全片解码检查无错误；抽帧 OCR 检查了双端审批与模型协议文字。音频合成后下调 2 dB 留出编码余量。检查不等于实体手机、公网 relay 或所有供应商的兼容性测试。
