# Auto Verification Code · 自动验证码

Microsoft Edge / Chromium 扩展（Manifest V3）：**自动接收短信验证码并填写**，并且**在本地离线识别图片验证码**。

所有识别都在你自己的电脑上完成，图片和验证码不会被上传到任何第三方服务。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 短信验证码自动填写 | 从你自己运行的本地桥接服务接收短信，自动解析出验证码并填入页面 |
| 图片验证码识别 | 内置离线 OCR（Tesseract WASM），自动截取验证码图片、预处理、识别并填入 |
| 智能字段识别 | 区分「短信验证码框」与「图片验证码框」，支持分格输入框、Shadow DOM、iframe |
| 多来源 | WebSocket 推送 / HTTP 轮询 / 剪贴板 / 手动粘贴 |
| 站点规则 | 全局黑名单，或只在白名单站点生效 |
| 安全默认值 | 自动提交默认关闭；验证码只存在内存中，浏览器关闭即清除 |

---

## 安装

1. 克隆或下载本仓库。
2. 准备离线 OCR 资源（仓库已包含，若缺失则执行）：
   ```bash
   npm run vendor
   ```
3. 打开 Edge，地址栏输入 `edge://extensions/`。
4. 打开左下角 **开发人员模式**。
5. 点击 **加载解压缩的扩展**，选择仓库中的 `extension/` 目录。

> Chrome / Chromium 同样适用：`chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序。
>
> 打包成 zip：`npm run build`，产物在 `dist/`。

---

## 快速开始

### 1）图片验证码 —— 装好就能用

无需任何配置。打开带图片验证码的登录页，扩展会自动找到验证码图片、识别并填入输入框。

在 **设置 → 图片验证码 → 识别测试** 里可以拖入一张验证码图片，直观看到预处理效果和识别结果，再据此调整参数。

### 2）短信验证码 —— 需要一个本地桥接

浏览器无法直接读取手机短信，所以需要一条「手机 → 电脑 → 浏览器」的通路。仓库自带一个零依赖的参考实现：

```bash
npm run bridge
```

启动后终端会打印一个随机令牌和三行配置：

```
WebSocket URL  ws://127.0.0.1:8787/ws
HTTP URL       http://127.0.0.1:8787/latest
token          xxxxxxxxxxxx
```

把这些填进 **扩展设置 → 短信来源 → WebSocket 推送**，点「测试连接」确认显示「连接成功」。

然后让手机把验证码短信转发到桥接服务（Android 用「短信转发器」类 App，iOS 用「快捷指令」自动化），详见 **[docs/SMS-SETUP.md](docs/SMS-SETUP.md)**。

先不接手机也能验证整条链路：

```bash
curl -X POST "http://127.0.0.1:8787/sms?token=你的令牌" \
     -H 'Content-Type: application/json' \
     -d '{"text":"【测试】您的验证码是 123456，5分钟内有效"}'
```

页面上的验证码输入框应当立刻被填上 `123456`。

---

## 文档

- **[docs/SMS-SETUP.md](docs/SMS-SETUP.md)** — 各种把短信送进浏览器的方式（Android / iOS / 剪贴板 / 自建接口）
- **[docs/OCR.md](docs/OCR.md)** — 识别率调优，以及接入自建 ddddocr / PaddleOCR 服务
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 代码结构与数据流
- **[bridge/README.md](bridge/README.md)** — 桥接服务的接口说明

---

## 隐私与安全

- **验证码不落盘。** 收到的验证码只写入 `chrome.storage.session`（纯内存），浏览器关闭即消失；界面上只显示打码后的形式。
- **识别全程离线。** 默认使用扩展内置的 Tesseract WASM，验证码图片不会离开本机。只有当你主动配置「自建 HTTP 接口」时，图片才会发往你自己指定的地址。
- **网络只连你配置的地址。** 扩展不会向作者或任何第三方发送数据。
- **自动提交默认关闭。** 填写是可撤销的，提交不是。确认识别稳定后再考虑开启。
- **建议把网银、支付等敏感站点加入设置里的黑名单。**

扩展申请 `<all_urls>` 主机权限，是因为验证码可能出现在任何站点，且跨域验证码图片需要读取像素。若只在少数站点使用，请在 **设置 → 站点规则** 中切换到「仅白名单站点」。

---

## 已知限制

- 内置 OCR 擅长「较清晰的数字 / 英文字母」验证码。**滑块、点选、旋转、reCAPTCHA、hCaptcha 等交互式验证码不在支持范围内**，扩展会直接忽略。
- 干扰严重、字符粘连的验证码识别率有限，可在设置里调整预处理参数，或改接自建 OCR 服务。
- 短信通路依赖你自己的转发方案；扩展本身不能读取手机。

---

## 开发

```bash
npm run check          # 静态检查：语法、JSON、manifest 引用、依赖资源
npm test               # 上面 + 短信解析 / 桥接协议 / 桥接服务 端到端
npm run test:browser   # 追加：真实 Chromium 加载扩展跑完整链路（较慢）
npm run build          # 打包 dist/*.zip
```

浏览器测试需要 Playwright 的 Chromium。测试会真实地：加载扩展 → 连接桥接 → 推送一条短信 → 断言输入框被填上 → 渲染一张验证码图片 → 断言被正确识别。

---

## License

MIT — 见 [LICENSE](LICENSE)。

内置 [Tesseract.js](https://github.com/naptha/tesseract.js)（Apache-2.0）与 [tessdata](https://github.com/tesseract-ocr/tessdata)（Apache-2.0）。
