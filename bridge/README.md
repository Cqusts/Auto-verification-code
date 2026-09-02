# SMS bridge

零依赖的本地服务，把手机转发过来的短信交给浏览器扩展。WebSocket 是手写实现（`ws.mjs`，约 150 行），所以整个仓库不需要 `npm install`。

```bash
node bridge/server.mjs [--port 8787] [--host 0.0.0.0] [--token secret] [--history 50] [--quiet]
```

未指定 `--token` 时会生成一个随机令牌并打印。也可用环境变量 `AVC_PORT` / `AVC_HOST` / `AVC_TOKEN`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/sms` | 收一条短信。接受 JSON、表单或纯文本 |
| `GET` | `/sms?text=...` | 同上，便于用浏览器或简单 App 触发 |
| `GET` | `/latest?limit=5` | 返回最近的消息，供扩展的 HTTP 轮询模式使用 |
| `GET` | `/ws` | WebSocket，实时推送每条新消息 |
| `GET` | `/status` | 服务状态与当前连接数 |

令牌可以放在 `?token=`、`X-Token` 头、`Authorization: Bearer` 头，或 JSON/表单体的 `token` 字段里。比较使用常量时间算法。

### POST /sms 接受的形态

```jsonc
{"text": "【某某】您的验证码是 123456"}   // 也支持 content / body / msg / message / sms
{"from": "10086", "text": "..."}          // from 可选，仅用于日志
"您的验证码是 123456"                      // Content-Type: text/plain
text=...&token=...                        // Content-Type: application/x-www-form-urlencoded
```

### WebSocket 推送格式

```json
{"id":"9f1c…","text":"【某某】您的验证码是 123456","from":"10086","receivedAt":1730000000000}
```

连接建立时先发一帧 `{"type":"hello","stored":N}`。服务端每 25 秒发一次 ping 保活。

## 安全

- 默认监听 `0.0.0.0`，手机才能从局域网访问；**请保留令牌**。只在本机自测时可加 `--host 127.0.0.1`。
- 消息只保存在内存里（默认最近 50 条），进程退出即消失。
- 请只在可信网络（家里的 Wi-Fi）中使用，不要把端口暴露到公网。

## 自测

```bash
node scripts/test-bridge.mjs
```

会真实启动服务并验证鉴权、HTTP、WebSocket 推送和三种请求体格式。
