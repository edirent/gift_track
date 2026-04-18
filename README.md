# gift_track

本项目使用 `Puppeteer + WebSocket` 在本地自动打开 B 站直播间、隐式注入抓取脚本，并把指定礼物事件推送到本地展示页。

这个方案不依赖油猴，也不需要手动把脚本复制到浏览器控制台。

## 快速开始

1. 安装依赖：

   ```bash
   npm install
   ```

2. 按需修改 [server.js](/home/edirent/gift_track/server.js:10) 顶部配置，或者用环境变量覆盖：

   - `ROOM_URL`
   - `TARGET_GIFT`
   - `PORT`
   - `HEADLESS`
   - `BROWSER_EXECUTABLE_PATH`

3. 启动服务：

   ```bash
   npm start
   ```

4. 打开本地展示页：

   ```text
   http://localhost:8080
   ```

5. 当直播间里出现目标礼物时：

   - 终端会打印用户昵称、UID 和礼物名
   - 本地展示页会追加一条礼物卡片

## 文件

- [server.js](/home/edirent/gift_track/server.js:1)
  启动本地 HTTP/WebSocket 服务，并自动控制浏览器打开直播间和注入抓取逻辑。
- [display.html](/home/edirent/gift_track/display.html:1)
  本地展示页，可直接用于浏览器或 OBS 浏览器源。
- [scripts/bili-gift-capture.js](/home/edirent/gift_track/scripts/bili-gift-capture.js:1)
  之前保留的纯前端抓取脚本，作为备用方案存在。
- [scripts/bili-gift-display.js](/home/edirent/gift_track/scripts/bili-gift-display.js:1)
  之前保留的纯前端接收端示例。

## 环境变量示例

```bash
ROOM_URL="https://live.bilibili.com/5440" \
TARGET_GIFT="人气票" \
HEADLESS=false \
PORT=8080 \
BROWSER_EXECUTABLE_PATH="/usr/bin/google-chrome" \
npm start
```

`HEADLESS` 支持 `false`、`true` 和 `new`。

## 本机浏览器路径示例

```bash
# Linux
BROWSER_EXECUTABLE_PATH="/usr/bin/google-chrome"

# macOS
BROWSER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Windows PowerShell
$env:BROWSER_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
```

## WSL 注意

如果你是在 WSL 里运行 Node，并把 `BROWSER_EXECUTABLE_PATH` 指向 Windows 宿主机的 `chrome.exe` 或 `msedge.exe`，路径本身可能是对的，但 Puppeteer 仍然可能因为调试通道问题启动失败。

在这种场景下，更稳的方案有两种：

- 直接在 Windows 侧运行这个项目，并使用 Windows 浏览器路径。
- 在 WSL 内安装原生 Linux 浏览器或补齐 Puppeteer 自带 Chromium 的运行依赖。

## 注意

- 首次安装 `puppeteer` 时会下载浏览器，时间会比普通依赖更久。
- 如果内置 Chromium 启动失败，可以通过 `BROWSER_EXECUTABLE_PATH` 指向本机现成的 Chrome/Chromium 可执行文件。
- 如果你要在 OBS 里使用展示页，直接把浏览器源地址指向 `http://127.0.0.1:8080` 即可。
- B 站页面结构如果变了，优先检查 [server.js](/home/edirent/gift_track/server.js:103) 里的选择器。
