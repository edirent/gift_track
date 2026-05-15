const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { WebSocketServer, WebSocket } = require("ws");
const puppeteer = require("puppeteer");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const ROOM_URL = process.env.ROOM_URL || "https://live.bilibili.com/5440";
const TARGET_GIFT = process.env.TARGET_GIFT || "人气票";
const shouldCaptureGift = (giftName, targetGift) =>
  Boolean(giftName) && (!targetGift || targetGift === "*" || giftName === targetGift);
const parseHeadlessMode = (value) => {
  const normalized = (value || "false").trim().toLowerCase();

  if (normalized === "new") {
    return "new";
  }

  return /^(1|true|yes)$/i.test(normalized);
};
const BROWSER_USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR || null;

const HEADLESS = parseHeadlessMode(process.env.HEADLESS);
const BROWSER_EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH || null;
const IS_WSL = os.release().toLowerCase().includes("microsoft");

const DISPLAY_FILE = path.join(__dirname, "display.html");
const WS_URL = `ws://127.0.0.1:${PORT}`;

let browser;
let isShuttingDown = false;

const serveDisplayPage = async (res) => {
  try {
    const html = await fs.readFile(DISPLAY_FILE, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`display.html 读取失败: ${error.message}`);
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  if (url.pathname === "/" || url.pathname === "/display.html") {
    await serveDisplayPage(res);
    return;
  }

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("🔗 [WS] 新客户端已连接");

  ws.on("message", (raw) => {
    let payload;

    try {
      payload = JSON.parse(raw.toString());
    } catch (error) {
      console.error(`⚠️ [WS] 收到无法解析的消息: ${error.message}`);
      return;
    }

    if (payload?.type !== "gift") {
      return;
    }

    if (!shouldCaptureGift(payload.giftName, TARGET_GIFT)) {
      return;
    }

    const giftCount = Number.parseInt(payload.comboCount || payload.giftCount || 1, 10) || 1;
    const giftDelta = Number.parseInt(payload.giftDelta || giftCount, 10) || giftCount;
    const countText = giftDelta !== giftCount ? `${giftCount}（新增 ${giftDelta}）` : `${giftCount}`;

    console.log(
      `🎁 [抓取成功] 用户: ${payload.uname} (UID: ${payload.uid}) 送出了【${payload.giftName}】x${countText}`,
    );

    const message = JSON.stringify(payload);
    for (const client of clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
  });

  ws.on("error", (error) => {
    clients.delete(ws);
    console.error(`⚠️ [WS] 客户端连接异常: ${error.message}`);
  });
});

const injectGiftTracker = async (page) => {
  await page.evaluate(
    ({ targetGift, wsUrl }) => {
      const LIST_SELECTOR = ".chat-history-list";
      const ITEM_SELECTOR = ".gift-item";
      const GIFT_NAME_SELECTOR = ".gift-name";
      const GIFT_COUNT_SELECTORS = [".gift-count", ".gift-num", ".gift-amount", ".gift-number", ".count", ".num"];
      const UID_ATTRIBUTES = ["data-uid", "data-userid", "data-user-id", "data-mid"];

      if (window.__biliGiftPuppeteer?.stop) {
        window.__biliGiftPuppeteer.stop();
      }

      const ws = new WebSocket(wsUrl);
      const giftNodeCounts = new WeakMap();

      const getGiftNode = (node) => {
        const element = node instanceof Element ? node : node?.parentElement;
        return element?.closest?.(ITEM_SELECTOR) || null;
      };

      const collectGiftNodes = (node) => {
        if (!(node instanceof Element)) {
          return [];
        }

        const giftNodes = [];
        if (node.matches(ITEM_SELECTOR)) {
          giftNodes.push(node);
        }

        giftNodes.push(...node.querySelectorAll(ITEM_SELECTOR));
        return giftNodes;
      };

      const parsePositiveInt = (value) => {
        const parsed = Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      };

      const getGiftCount = (giftNode) => {
        const attrCount = [
          "data-count",
          "data-num",
          "data-gift-count",
          "data-gift-num",
        ]
          .map((attrName) => parsePositiveInt(giftNode.getAttribute(attrName)))
          .find((value) => value !== null);

        if (attrCount !== undefined) {
          return attrCount;
        }

        for (const selector of GIFT_COUNT_SELECTORS) {
          const count = parsePositiveInt(giftNode.querySelector(selector)?.textContent);
          if (count !== null) {
            return count;
          }
        }

        const textCount = giftNode.textContent?.match(/[xX×*]\s*(\d+)/)?.[1];
        return parsePositiveInt(textCount) || 1;
      };

      const getFirstAttribute = (node, attrNames) => {
        for (const attrName of attrNames) {
          const value = node.getAttribute(attrName);
          if (value) {
            return value;
          }
        }

        return null;
      };

      const buildPayload = (giftNode, giftCount, giftDelta) => {
        const giftName = giftNode.querySelector(GIFT_NAME_SELECTOR)?.textContent?.trim();
        if (!giftName || !(targetGift === "*" || giftName === targetGift)) {
          return null;
        }

        return {
          type: "gift",
          uid: getFirstAttribute(giftNode, UID_ATTRIBUTES),
          uname: giftNode.getAttribute("data-uname")?.trim() || "未知用户",
          giftName,
          giftCount,
          giftDelta,
          comboCount: giftCount,
          capturedAt: new Date().toISOString(),
        };
      };

      const handleGiftNode = (giftNode) => {
        const giftCount = getGiftCount(giftNode);
        const giftKey = [
          getFirstAttribute(giftNode, UID_ATTRIBUTES) || "",
          giftNode.getAttribute("data-uname")?.trim() || "",
          giftNode.querySelector(GIFT_NAME_SELECTOR)?.textContent?.trim() || "",
        ].join(":");
        const previousState = giftNodeCounts.get(giftNode);
        const previousCount = previousState?.key === giftKey ? previousState.count : 0;

        if (giftCount === previousCount) {
          return;
        }

        const giftDelta = giftCount > previousCount ? giftCount - previousCount : giftCount;
        const payload = buildPayload(giftNode, giftCount, giftDelta);
        if (!payload || ws.readyState !== WebSocket.OPEN) {
          return;
        }

        giftNodeCounts.set(giftNode, { key: giftKey, count: giftCount });
        ws.send(JSON.stringify(payload));
      };

      const observer = new MutationObserver((mutationsList) => {
        const pendingGiftNodes = new Set();

        for (const mutation of mutationsList) {
          if (mutation.type === "childList") {
            mutation.addedNodes.forEach((node) => {
              collectGiftNodes(node).forEach((giftNode) => pendingGiftNodes.add(giftNode));
            });

            const giftNode = getGiftNode(mutation.target);
            if (giftNode) {
              pendingGiftNodes.add(giftNode);
            }
            continue;
          }

          if (mutation.type === "characterData" || mutation.type === "attributes") {
            const giftNode = getGiftNode(mutation.target);
            if (giftNode) {
              pendingGiftNodes.add(giftNode);
            }
          }
        }

        pendingGiftNodes.forEach(handleGiftNode);
      });

      const start = () => {
        const targetNode = document.querySelector(LIST_SELECTOR) || document.body;
        observer.observe(targetNode, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        console.log(`[Inject] 正在监听页面礼物流，目标礼物: ${targetGift}`);
      };

      const stop = () => {
        observer.disconnect();
        ws.close();
        delete window.__biliGiftPuppeteer;
        console.log("[Inject] 已停止监听");
      };

      ws.addEventListener("open", () => {
        console.log("[Inject] 已连接本地 WS 服务");
      });

      ws.addEventListener("error", () => {
        console.log("[Inject] 连接本地 WS 服务失败");
      });

      window.__biliGiftPuppeteer = { stop };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
      } else {
        start();
      }
    },
    { targetGift: TARGET_GIFT, wsUrl: WS_URL },
  );
};

const launchBrowser = async () => {
  console.log("🚀 [System] 正在启动自动化浏览器...");

  if (IS_WSL && BROWSER_EXECUTABLE_PATH?.toLowerCase().endsWith(".exe")) {
    console.warn(
      "⚠️ [System] 当前运行在 WSL 中，且配置的是 Windows 浏览器可执行文件。此组合可能因调试通道问题启动失败。更稳的方案是：在 Windows 侧运行 Node，或在 WSL 内安装原生 Linux 浏览器。",
    );
  }

  browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: null,
    executablePath: BROWSER_EXECUTABLE_PATH,
    userDataDir: BROWSER_USER_DATA_DIR,
  });


  const page = await browser.newPage();

  page.on("console", (message) => {
    console.log(message.text());
  });

  page.on("pageerror", (error) => {
    console.error(`⚠️ [Page] ${error.message}`);
  });

  console.log(`🌐 [System] 正在访问直播间: ${ROOM_URL}`);
  await page.goto(ROOM_URL, { waitUntil: "domcontentloaded" });

  console.log("💉 [System] 正在向直播间注入抓取脚本...");
  await injectGiftTracker(page);

  console.log(`🎯 [System] 注入成功，当前监听礼物: ${TARGET_GIFT}`);
};

const shutdown = async (signal) => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`\n🛑 [System] 收到 ${signal}，正在关闭服务...`);

  wss.clients.forEach((client) => {
    client.close();
  });

  await new Promise((resolve) => server.close(resolve));

  if (browser) {
    await browser.close();
  }

  process.exit(0);
};

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error(`❌ [System] 关闭失败: ${error.message}`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error(`❌ [System] 关闭失败: ${error.message}`);
    process.exit(1);
  });
});

server.listen(PORT, async () => {
  console.log(`🟢 [System] 本地服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`🟢 [System] WebSocket 地址: ${WS_URL}`);

  try {
    await launchBrowser();
  } catch (error) {
    console.error(`❌ [System] 浏览器自动化启动失败: ${error.message}`);
    process.exit(1);
  }
});
