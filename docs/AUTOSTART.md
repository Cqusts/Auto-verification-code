# 让桥接服务开机自启

短信自动填写需要桥接服务在后台运行。配成开机自启之后就是一次性的事 —— 装一次，之后开机自动跑，你不用再管它。

图片验证码识别不依赖桥接服务，本页只和短信功能有关。

---

## 一条命令搞定

```bash
npm run autostart:install          # 安装自启
npm run autostart                  # 查看状态
npm run autostart:uninstall        # 关闭自启
```

安装脚本会自动识别系统，用当前用户的身份安装，**全程不需要管理员 / root 权限**：

| 系统 | 用的机制 | 装到哪儿 |
| --- | --- | --- |
| Windows | 启动文件夹 + 隐藏窗口启动器 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\auto-verification-code-bridge.vbs` |
| macOS | LaunchAgent | `~/Library/LaunchAgents/com.auto-verification-code.bridge.plist` |
| Linux | systemd user service | `~/.config/systemd/user/auto-verification-code-bridge.service` |

安装完会打印你要填进扩展的地址和令牌：

```
完成。扩展设置 → 短信来源 → WebSocket 推送：
  地址   ws://127.0.0.1:8787/ws
  令牌   XfqlaAJ2h1T0

  正在运行  http://127.0.0.1:8787  已连接扩展 0 个
```

最后那行是真的去访问了一次端口，而不是只看服务管理器怎么说 —— 服务「已启用」和「真的在跑」是两回事。

### 可选参数

```bash
npm run autostart:install -- --port 9000        # 换端口
npm run autostart:install -- --host 127.0.0.1   # 只允许本机访问（手机就连不上了）
```

想先看看会往你系统里写什么，不实际安装：

```bash
node bridge/autostart.mjs install --dry-run
node bridge/autostart.mjs install --platform win32   # 预览另一个系统的配置，绝不碰当前机器
```

---

## 关掉自启

### 用脚本（推荐）

```bash
npm run autostart:uninstall
```

它会先停掉服务，再删掉安装时写入的文件，并逐行打印删了什么。令牌文件会**保留** —— 这样以后重新装回来时，扩展里已经填好的令牌还能继续用。要彻底清除见文末。

### 手动关掉

脚本跑不了（比如仓库已经删了）时，按系统手动删就行。

**Windows**

1. 按 `Win + R`，输入 `shell:startup`，回车
2. 删掉里面的 `auto-verification-code-bridge.vbs`
3. 可选：删掉 `%LOCALAPPDATA%\auto-verification-code\bridge.cmd`

删完之后**当前正在跑的那个实例还会继续运行**，直到你注销或重启。想立刻停掉：任务管理器 → 详细信息 → 找到 `node.exe` → 结束任务。

**macOS**

```bash
launchctl bootout gui/$(id -u)/com.auto-verification-code.bridge
rm ~/Library/LaunchAgents/com.auto-verification-code.bridge.plist
```

`bootout` 会立刻停掉正在运行的进程。老版本 macOS 如果提示 `bootout` 不认识，用 `launchctl unload -w <plist 路径>`。

**Linux**

```bash
systemctl --user disable --now auto-verification-code-bridge.service
rm ~/.config/systemd/user/auto-verification-code-bridge.service
systemctl --user daemon-reload
```

`--now` 会顺带停掉正在运行的服务。

### 只是想临时停一下，不卸载

```bash
# macOS
launchctl bootout gui/$(id -u)/com.auto-verification-code.bridge     # 停
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.auto-verification-code.bridge.plist   # 再启

# Linux
systemctl --user stop auto-verification-code-bridge
systemctl --user start auto-verification-code-bridge
```

Windows 没有对应的「暂停」概念：结束 `node.exe` 进程即可停止，下次登录会自动起来。

也可以完全不动服务，只在**扩展设置 → 短信来源**里把 WebSocket 关掉 —— 效果一样，而且改回来更方便。

---

## 令牌

令牌是手机和扩展访问桥接服务的凭据。它**只生成一次**，之后保存在：

| 系统 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\auto-verification-code\token` |
| macOS | `~/Library/Application Support/auto-verification-code/token` |
| Linux | `~/.config/auto-verification-code/token` |

（POSIX 系统上权限是 `600`，只有你本人可读。）

之所以要持久化，是因为自启后每次开机都重新生成一个随机令牌的话，扩展里存的那个立刻就失效了。

忘了令牌就跑 `npm run autostart`，状态里会打印出来。想换一个：删掉令牌文件，重启服务，再把新令牌填进扩展。

自启服务用 `--quiet` 模式运行，所以日志文件里**不会出现验证码内容，也不会出现令牌**。

---

## 日志与排错

| 系统 | 看日志 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\auto-verification-code\bridge.log` |
| macOS | `tail -f ~/Library/Logs/auto-verification-code-bridge.log` |
| Linux | `journalctl --user -u auto-verification-code-bridge -f` |

**装完显示「端口无响应」。** 手动跑一次看真实报错：

```bash
node bridge/server.mjs --port 8787
```

最常见的是端口被占用，换个端口重装即可。

**Linux：注销后服务就停了。** systemd 默认在你退出登录时结束 user 服务。开启常驻：

```bash
sudo loginctl enable-linger $USER
```

**Windows：开机后手机连不上。** 防火墙在拦。第一次运行时的弹窗要勾「专用网络」；如果当时点了取消，去「Windows 防火墙 → 允许应用通过防火墙」里给 Node.js 补上。

**换了电脑 IP，手机连不上了。** 桥接服务本身没问题，是手机上的转发地址过期了。改手机端配置，或在路由器上给电脑绑一个固定 IP。
