# gift_track

本项目使用 `Puppeteer + WebSocket` 在本地自动打开 B 站直播间、隐式注入抓取脚本，并把指定礼物事件推送到本地展示页。

这个方案不依赖油猴，也不需要手动把脚本复制到浏览器控制台。

## 快速开始

1. 安装依赖：

   ```bash
   npm install
   pip install -r requirements.txt
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

6. 如果要把抓到的 UID 自动私信，另开一个终端运行：

   ```bash
   npm run auto-send
   ```

   首次建议先用测试模式确认 UID 记录链路：

   ```bash
   DRY_RUN=true npm run auto-send
   ```

## 文件

- [server.js](/home/edirent/gift_track/server.js:1)
  启动本地 HTTP/WebSocket 服务，并自动控制浏览器打开直播间和注入抓取逻辑。
- [display.html](/home/edirent/gift_track/display.html:1)
  本地展示页，可直接用于浏览器或 OBS 浏览器源。
- [auto-send-gift-users.js](/home/edirent/gift_track/auto-send-gift-users.js:1)
  连接本地 WebSocket，记录 `server.js` 抓到的 UID，并调用 `bili_test.py` 给对应用户发私信。
- [bili_test.py](/home/edirent/gift_track/bili_test.py:1)
  B 站私信发送脚本，可单独指定 UID 发送，也会被自动私信程序调用。
- [scripts/bili-gift-capture.js](/home/edirent/gift_track/scripts/bili-gift-capture.js:1)
  之前保留的纯前端抓取脚本，作为备用方案存在。
- [scripts/bili-gift-display.js](/home/edirent/gift_track/scripts/bili-gift-display.js:1)
  之前保留的纯前端接收端示例。

## 自动私信

自动私信程序会监听 `server.js` 广播出来的礼物事件，把每次抓到的 UID 写到 `data/captured_uids.jsonl`，成功发送过的 UID 写到 `data/sent_uids.json`。默认同一个 UID 只发送一次。

按指定礼物和单次礼物数量发送：

```bash
npm run auto-send -- --gift-target 人气票 --gift-count 3 --message "感谢 {{uname}} 送出的 {{giftCount}} 个 {{giftName}}！"
```

如果要按用户累计数量判断：

```bash
npm run auto-send -- --gift-target 人气票 --gift-count 10 --count-mode total
```

如果要让自动私信程序自己判断多个礼物规则，启动抓取服务时先抓所有礼物：

```bash
TARGET_GIFT="*" npm start
```

自定义多规则示例：

```bash
GIFT_RULES='[
  {"giftName":"人气票","minCount":3,"message":"感谢 {{uname}} 的 {{giftCount}} 张人气票！"},
  {"giftName":"小花花","minCount":1,"mode":"total","message":"谢谢 {{uname}} 累计送出 {{totalCount}} 个 {{giftName}}！"}
]' npm run auto-send
```

`GIFT_RULES` 也可以填写 JSON 文件路径，例如 `GIFT_RULES=./gift-rules.json npm run auto-send`。

可用环境变量：

- `BILI_MESSAGE`：私信内容，默认 `感谢你的礼物！`
- `SEND_GIFT_TARGET` / `GIFT_TARGET`：要触发私信的礼物名，省略或设为 `*` 表示任意礼物
- `MIN_GIFT_COUNT` / `GIFT_COUNT`：触发私信的最小礼物数量，默认 `1`
- `COUNT_MODE`：数量判断方式，`event` 表示单次礼物，`total` 表示按用户累计，默认 `event`
- `GIFT_RULES`：自定义规则 JSON 或 JSON 文件路径
- `SEND_ONCE`：是否同 UID 只发一次，默认 `true`
- `DRY_RUN`：只记录不发送，默认 `false`
- `GIFT_WS_URL`：WebSocket 地址，默认读取 `PORT` 并连接 `ws://127.0.0.1:8080`
- `UID_LOG_FILE`：UID 抓取记录文件，默认 `data/captured_uids.jsonl`
- `SENT_UID_FILE`：已成功发送 UID 文件，默认 `data/sent_uids.json`
- `PYTHON`：调用 Python 的命令，Linux 默认 `python3`，Windows 默认 `python`

也可以直接用 `bili_test.py` 给指定 UID 发一条：

```bash
python3 bili_test.py 123456 -m "感谢你的礼物！"
```

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

`TARGET_GIFT` 默认只抓 `人气票`，设为 `*` 时会抓所有礼物，再交给自动私信规则判断。

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
