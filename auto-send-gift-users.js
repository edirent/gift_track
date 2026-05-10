const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { WebSocket } = require("ws");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const WS_URL = process.env.GIFT_WS_URL || `ws://127.0.0.1:${PORT}`;
const UID_LOG_FILE = path.resolve(
  process.env.UID_LOG_FILE || path.join(__dirname, "data", "captured_uids.jsonl"),
);
const SENT_UID_FILE = path.resolve(
  process.env.SENT_UID_FILE || path.join(__dirname, "data", "sent_uids.json"),
);
const BILI_TEST = path.resolve(process.env.BILI_TEST || path.join(__dirname, "bili_test.py"));
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const MESSAGE = process.env.BILI_MESSAGE || "感谢你的礼物！";
const SEND_ONCE = !/^(0|false|no)$/i.test(process.env.SEND_ONCE || "true");
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "false");
const RECONNECT_MS = Number.parseInt(process.env.RECONNECT_MS || "3000", 10);

const sentUids = new Set();

let activeSocket = null;
let isShuttingDown = false;
let sendQueue = Promise.resolve();

const ensureParentDir = async (filePath) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};

const normalizeUid = (value) => {
  const uid = String(value ?? "").trim();
  return /^\d+$/.test(uid) ? uid : null;
};

const loadSentUids = async () => {
  try {
    const raw = await fs.readFile(SENT_UID_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const uids = Array.isArray(parsed) ? parsed : parsed.uids;
    return Array.isArray(uids) ? uids.map(normalizeUid).filter(Boolean) : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

const saveSentUids = async () => {
  await ensureParentDir(SENT_UID_FILE);
  const uids = [...sentUids].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const payload = {
    updatedAt: new Date().toISOString(),
    uids,
  };

  await fs.writeFile(SENT_UID_FILE, `${JSON.stringify(payload, null, 2)}\n`);
};

const appendCapturedUid = async (payload, uid) => {
  await ensureParentDir(UID_LOG_FILE);

  const record = {
    uid,
    uname: payload.uname || "未知用户",
    giftName: payload.giftName || "未知礼物",
    capturedAt: payload.capturedAt || null,
    receivedAt: new Date().toISOString(),
  };

  await fs.appendFile(UID_LOG_FILE, `${JSON.stringify(record)}\n`);
};

const formatProcessOutput = (stdout, stderr) => {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return output || "无输出";
};

const runBiliTest = (uid) => {
  const args = [BILI_TEST, uid, "--message", MESSAGE, "--json"];

  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      cwd: __dirname,
      env: process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      const output = formatProcessOutput(stdout, stderr);

      if (code !== 0) {
        reject(new Error(`bili_test.py 退出码 ${code}: ${output}`));
        return;
      }

      try {
        const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "{}";
        resolve(JSON.parse(lastLine));
      } catch (error) {
        reject(new Error(`无法解析 bili_test.py 输出: ${output}`));
      }
    });
  });
};

const sendToGiftUser = async (payload) => {
  const uid = normalizeUid(payload.uid);

  if (!uid) {
    console.warn("⚠️ [Gift] 收到礼物事件，但 UID 无效，已跳过");
    return;
  }

  await appendCapturedUid(payload, uid);

  if (SEND_ONCE && sentUids.has(uid)) {
    console.log(`↩️ [Gift] UID ${uid} 已成功发送过，本次只记录不重复发送`);
    return;
  }

  if (DRY_RUN) {
    console.log(`🧪 [Gift] DRY_RUN 已记录 UID ${uid}，不会调用 bili_test.py`);
    return;
  }

  console.log(`📨 [Gift] 正在向 ${payload.uname || "未知用户"} (UID: ${uid}) 发送私信...`);
  const result = await runBiliTest(uid);

  if (result.code !== 0) {
    throw new Error(`B站接口返回失败: ${JSON.stringify(result)}`);
  }

  sentUids.add(uid);
  await saveSentUids();
  console.log(`✅ [Gift] UID ${uid} 已发送并写入 ${SENT_UID_FILE}`);
};

const queueGiftPayload = (payload) => {
  sendQueue = sendQueue
    .then(() => sendToGiftUser(payload))
    .catch((error) => {
      console.error(`❌ [Gift] 处理失败: ${error.message}`);
    });
};

const handleSocketMessage = (raw) => {
  let payload;

  try {
    payload = JSON.parse(raw.toString());
  } catch (error) {
    console.warn(`⚠️ [WS] 收到无法解析的消息: ${error.message}`);
    return;
  }

  if (payload?.type !== "gift") {
    return;
  }

  queueGiftPayload(payload);
};

const scheduleReconnect = () => {
  if (isShuttingDown) {
    return;
  }

  setTimeout(connect, RECONNECT_MS);
};

function connect() {
  if (isShuttingDown) {
    return;
  }

  activeSocket = new WebSocket(WS_URL);

  activeSocket.on("open", () => {
    console.log(`🔗 [WS] 已连接 ${WS_URL}`);
  });

  activeSocket.on("message", handleSocketMessage);

  activeSocket.on("close", (code, reason) => {
    const reasonText = reason?.toString() ? `，原因: ${reason.toString()}` : "";
    console.log(`🔌 [WS] 连接关闭 (${code}${reasonText})，${RECONNECT_MS}ms 后重连`);
    scheduleReconnect();
  });

  activeSocket.on("error", (error) => {
    console.error(`⚠️ [WS] 连接异常: ${error.message}`);
  });
}

const shutdown = (signal) => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`\n🛑 [System] 收到 ${signal}，等待队列处理完成后退出...`);

  if (
    activeSocket &&
    (activeSocket.readyState === WebSocket.OPEN || activeSocket.readyState === WebSocket.CONNECTING)
  ) {
    activeSocket.close();
  }

  const forceExitTimer = setTimeout(() => {
    process.exit(0);
  }, 5000);
  forceExitTimer.unref();

  sendQueue.finally(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
};

const main = async () => {
  await fs.access(BILI_TEST);

  for (const uid of await loadSentUids()) {
    sentUids.add(uid);
  }

  console.log("🟢 [System] 礼物 UID 自动私信程序已启动");
  console.log(`🟢 [System] WebSocket: ${WS_URL}`);
  console.log(`🟢 [System] UID 记录: ${UID_LOG_FILE}`);
  console.log(`🟢 [System] 已发送记录: ${SENT_UID_FILE}`);
  console.log(`🟢 [System] 同 UID 只发送一次: ${SEND_ONCE ? "是" : "否"}`);

  if (DRY_RUN) {
    console.log("🧪 [System] 当前为 DRY_RUN 模式，不会真实发送私信");
  }

  connect();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  console.error(`❌ [System] 启动失败: ${error.message}`);
  process.exit(1);
});
