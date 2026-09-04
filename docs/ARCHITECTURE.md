# 代码结构

## 分层

Manifest V3 把扩展拆成几个生命周期完全不同的上下文，本项目按各自的能力分工：

```
┌─ content script ────────────────────────────────────────────┐
│  运行在每个页面/iframe 里。找字段、读验证码图片的像素、       │
│  模拟键盘填写、显示状态标签。唯一能碰 DOM 的地方。            │
└───────────────┬─────────────────────────────────────────────┘
                │ chrome.tabs / runtime 消息
┌───────────────▼─────────────────────────────────────────────┐
│  service worker（后台）                                      │
│  真相来源：设置、验证码仓库、字段登记表、站点规则、频率限制。 │
│  随时会被浏览器杀死重启，因此所有状态都镜像到 storage。       │
└───────────────┬─────────────────────────────────────────────┘
                │ runtime 消息
┌───────────────▼─────────────────────────────────────────────┐
│  offscreen document                                          │
│  需要长连接与真实 DOM 的活都在这儿：短信桥接的 WebSocket /    │
│  HTTP 轮询、canvas 图像预处理、Tesseract worker。            │
└─────────────────────────────────────────────────────────────┘
```

**为什么要 offscreen document：** service worker 空闲约 30 秒就会被回收，无法持有 WebSocket 或 `setInterval`，也没有 `document` / `canvas`。offscreen document 两样都有，并通过一条长连接的 port 顺带把 worker 保活。

**为什么 content script 是 ES module：** content script 本身不能是模块，所以 `loader.js`（普通脚本）动态 `import()` 真正的实现 `main.js`。动态导入的模块仍运行在隔离世界、仍能访问 `chrome.*`，于是页面侧代码可以和后台共用 `src/common/` 里的解析逻辑，不必复制一份。

## 目录

```
extension/
  manifest.json
  src/
    common/            三个上下文共用
      constants.js     消息类型、存储键、硬性上限
      defaults.js      全部默认配置（配置项的唯一定义处）
      settings.js      读写与深合并，跨上下文变更通知
      patterns.js      字段命名/短信关键词的正则与词表
      code-extract.js  短信 → 验证码的打分式解析（有回归测试）
      site-rules.js    黑白名单判定
      messaging.js     消息封装，永远返回 {ok, data|error}
      util.js          限流器、节流、掩码等
      logger.js        环形缓冲日志
    background/
      service-worker.js 消息路由与编排
      state.js          验证码仓库 + 字段登记表（均在 session 存储）
      offscreen.js      offscreen 文档的生命周期
      image.js          截屏与兜底 fetch
    offscreen/
      offscreen.html/js 消息入口 + 保活
      bridge-client.js  WebSocket 重连 + HTTP 轮询 + 载荷归一化
      ocr-engine.js     Tesseract worker、多方案择优、自建接口
      image-lab.js      裁剪/缩放/灰度/大津二值化/去噪
    content/
      loader.js         普通脚本，动态导入下面的模块
      main.js           扫描调度与消息处理
      field-detect.js   字段分类与验证码图片定位
      fill.js           拟真输入、分格填写、提交
      captcha.js        取像素 → 识别 → 填写 → 重试
      overlay.js/css    输入框旁的状态标签
    popup/  options/    界面
  vendor/tesseract/     离线 OCR 资源
bridge/                 零依赖短信桥接服务（含手写 WebSocket 实现）
scripts/                取依赖、生成图标、检查、测试、打包
test/fixtures/          浏览器端到端测试用的页面
```

## 关键数据流

### 短信验证码

```
桥接服务 --WS--> offscreen --BRIDGE_MESSAGE--> service worker
   extractCode() 打分解析 → 存入 session 仓库
   → 按「当前活动标签页优先 + 最近出现的字段优先」挑选目标 frame
   → DELIVER_CODE → content script 填写 → 回报是否成功 → 标记已消费
```

短信先到、页面后开也能工作：content script 发现验证码输入框时会主动询问后台是否有未消费的新验证码。

### 图片验证码

```
content 扫描到「验证码输入框 + 相邻图片」
   → 取像素（canvas / 截屏裁剪 / 兜底 fetch）
   → REQUEST_OCR → service worker（校验站点规则与频率限制）
   → offscreen：预处理 → Tesseract 多方案择优
   → 回到 content：清洗 → 填入，或给出「采用」按钮
```

## 字段分类

`verifyCode` 这类命名天然有歧义：在国内站点它是图片验证码的概率和是短信验证码的概率差不多。因此正则分成三档：

- **明确的短信**（`smsCode`、`otp`、`短信验证码`、`动态码`）→ +80
- **明确的图片**（`captcha`、`imgCode`、`图形验证码`）→ +80
- **歧义**（`verifyCode`、`验证码`、`vcode`）→ 两边各 +30

再用 DOM 证据裁决：**旁边有验证码图片** → 图片验证码 +70；**旁边有「获取验证码」按钮**（且距离 320px 以内）→ 短信 +55。`autocomplete="one-time-code"` 直接 150 分，压过一切启发式。

搜索范围止步于最近的 `form` / `fieldset` 且永不扩大到 `<body>` —— 一旦放大到整页，页面上任意一个「获取验证码」按钮都会让所有输入框看起来像短信框。

命名毫无线索时（`id="input3"` 这类），**旁边 320px 内的「获取验证码」按钮本身就足够定性** —— 页面上没有别的控件长这样。为避免误伤同样靠近该按钮的手机号框，这条路径会排除命名像手机号/账号/邮箱的字段，并按到按钮的距离打分，离得近的胜出。

再认不出来就交给用户：弹窗里的「手动指定输入框」进入取词模式，点中的字段会生成一个尽量稳定的选择器（`#id` → `[name]` → 结构路径，跳过 React 那种每次渲染都变的 id），按 hostname 存进 `sites.fieldOverrides`。有覆盖项时它直接胜过所有启发式。

取词是**广播到所有 frame 后就地确认**，不是「等一个返回值」：登录表单常在 iframe 里，而弹窗在页面获得焦点的一瞬间就关闭了，根本没人接收返回值。所以每个 frame 各自进入取词模式，用户点中的那个 frame 把结果推给后台，后台保存后再广播取消给其余 frame，确认提示由页面自己弹出。iframe 里的字段按 **iframe 自己的 hostname** 记录 —— 将来要找回它的正是那个 frame 里的内容脚本。

## 状态与生命周期

service worker 随时可能被回收，所以：

- 设置放 `chrome.storage.local`（持久），验证码与字段登记表放 `chrome.storage.session`（内存，浏览器关闭即清）
- 每个存储类都能在新的 worker 实例里 `hydrate()` 回来
- 启用短信桥接时，offscreen document 每 20 秒通过 port 发一次心跳把 worker 顶住

## 测试

- `scripts/test-extract.mjs` —— 短信解析回归集（含各种「不该被当成验证码」的反例）
- `scripts/test-bridge-parse.mjs` —— 各种转发 App 载荷形态的归一化
- `scripts/test-bridge.mjs` —— 真实启动桥接服务，跑 HTTP 与 WebSocket
- `scripts/test-browser.mjs` —— 真实 Chromium 加载扩展，端到端验证填写与识别
- `scripts/check.mjs` —— 语法、JSON、manifest 引用、依赖资源完整性
