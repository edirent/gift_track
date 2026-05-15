const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { WebSocket } = require("ws");

const parseCliArgs = (argv) => {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

    if (key === "help") {
      args.help = true;
      continue;
    }

    if (key === "noSendOnce") {
      args.sendOnce = false;
      continue;
    }

    if (key === "dryRun" && inlineValue === undefined) {
      args.dryRun = true;
      continue;
    }

    args[key] = inlineValue !== undefined ? inlineValue : argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return args;
};

const printUsage = () => {
  console.log(`Usage:
  npm run auto-send -- --gift-target 人气票 --gift-count 3
  npm run auto-send -- --rules ./gift-rules.json

Options:
  --gift-target <name>   要触发私信的礼物名，省略或设为 * 表示任意礼物
  --gift-count <number>  触发私信的最小礼物数量，默认 1
  --count-mode <mode>    event 按单次礼物判断，total 按用户累计判断，默认 event
  --message <text>       私信内容，支持 {{uname}}、{{giftName}}、{{giftCount}} 等模板变量
  --rules <json|file>    自定义规则 JSON 或 JSON 文件路径
  --dry-run              只记录不发送
  --no-send-once         允许同一个 UID 多次发送`);
};

const cli = parseCliArgs(process.argv.slice(2));

if (cli.help) {
  printUsage();
  process.exit(0);
}

const pickOption = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (/^(1|true|yes|on)$/i.test(value)) {
    return true;
  }

  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }

  return fallback;
};

const normalizeCountMode = (value) => {
  const mode = String(value || "event").trim().toLowerCase();
  return mode === "total" ? "total" : "event";
};

const PORT = parsePositiveInt(pickOption(cli.port, process.env.PORT), 8080);
const WS_URL = pickOption(cli.wsUrl, process.env.GIFT_WS_URL) || `ws://127.0.0.1:${PORT}`;
const UID_LOG_FILE = path.resolve(
  pickOption(cli.uidLogFile, process.env.UID_LOG_FILE) || path.join(__dirname, "data", "captured_uids.jsonl"),
);
const SENT_UID_FILE = path.resolve(
  pickOption(cli.sentUidFile, process.env.SENT_UID_FILE) || path.join(__dirname, "data", "sent_uids.json"),
);
const BILI_TEST = path.resolve(pickOption(cli.biliTest, process.env.BILI_TEST) || path.join(__dirname, "bili_test.py"));
const PYTHON = pickOption(cli.python, process.env.PYTHON) || (process.platform === "win32" ? "python" : "python3");
const MESSAGE = pickOption(cli.message, process.env.BILI_MESSAGE) || "🐧：3271920070 直接点空间拿全套（此号无人回复但会补档更新！有问题找主播！任何找你要钱或者要你下软件的都是骗子！））";
const DEFAULT_GIFT_TARGET = String(
  pickOption(cli.giftTarget, process.env.SEND_GIFT_TARGET, process.env.GIFT_TARGET) || "",
).trim();
const DEFAULT_MIN_GIFT_COUNT = parsePositiveInt(
  pickOption(cli.giftCount, process.env.MIN_GIFT_COUNT, process.env.GIFT_COUNT),
  1,
);
const DEFAULT_COUNT_MODE = normalizeCountMode(pickOption(cli.countMode, process.env.COUNT_MODE));
const RULES_SOURCE = pickOption(cli.rules, process.env.GIFT_RULES, process.env.GIFT_RULES_FILE);
const SEND_ONCE = parseBoolean(pickOption(cli.sendOnce, process.env.SEND_ONCE), true);
const DRY_RUN = parseBoolean(pickOption(cli.dryRun, process.env.DRY_RUN), false);
const RECONNECT_MS = parsePositiveInt(pickOption(cli.reconnectMs, process.env.RECONNECT_MS), 3000);
const SEND_INTERVAL_MS = parsePositiveInt(pickOption(cli.sendIntervalMs, process.env.SEND_INTERVAL_MS), 2000);
const FAILURE_COOLDOWN_MS = parsePositiveInt(
  pickOption(cli.failureCooldownMs, process.env.FAILURE_COOLDOWN_MS),
  10 * 60 * 1000,
);
const CONSECUTIVE_FAIL_LIMIT = parsePositiveInt(
  pickOption(cli.consecutiveFailLimit, process.env.CONSECUTIVE_FAIL_LIMIT),
  5,
);
const FAILED_UID_FILE = path.resolve(
  pickOption(cli.failedUidFile, process.env.FAILED_UID_FILE) || path.join(__dirname, "data", "failed_uids.jsonl"),
);

// TODO: 占位 code，需要根据 B 站实际返回值补全。
//   fatal: cookie 失效 / 未登录 / 账号封禁 — 命中后停止消费者，不自动恢复
//   ratelimit: 频控 / 风控 — 命中后冷却 FAILURE_COOLDOWN_MS
const FATAL_CODES = [-101, -111, -400, 401];
const RATELIMIT_CODES = [-352, 22003, 22014];

const sentUids = new Set();
const giftTotals = new Map();
const pendingQueue = [];

let activeSocket = null;
let isShuttingDown = false;
let consumerRunning = false;
let consumerStopped = false;
let consumerPromise = Promise.resolve();
let pausedUntil = 0;
let consecutiveFailures = 0;
let totalFailures = 0;
let giftRules = [];

const ensureParentDir = async (filePath) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};

const normalizeUid = (value) => {
  const uid = String(value ?? "").trim();
  return /^\d+$/.test(uid) ? uid : null;
};

const normalizeGiftName = (value) => String(value || "").trim();

const getGiftCount = (payload) =>
  parsePositiveInt(payload.giftCount ?? payload.count ?? payload.num ?? payload.giftNum, 1);

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

const appendFailedUid = async (record) => {
  await ensureParentDir(FAILED_UID_FILE);
  await fs.appendFile(FAILED_UID_FILE, `${JSON.stringify(record)}\n`);
};

const categorizeFailure = ({ code, error }) => {
  if (code !== undefined && code !== null) {
    if (FATAL_CODES.includes(code)) return "fatal";
    if (RATELIMIT_CODES.includes(code)) return "ratelimit";
    return "other";
  }

  const message = String(error?.message || "");
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout/i.test(message)) return "timeout";
  return "other";
};

const appendCapturedUid = async (payload, uid) => {
  await ensureParentDir(UID_LOG_FILE);

  const record = {
    uid,
    uname: payload.uname || "未知用户",
    giftName: payload.giftName || "未知礼物",
    giftCount: getGiftCount(payload),
    capturedAt: payload.capturedAt || null,
    receivedAt: new Date().toISOString(),
  };

  await fs.appendFile(UID_LOG_FILE, `${JSON.stringify(record)}\n`);
};

const readRulesSource = async (source) => {
  if (!source) {
    return null;
  }

  const trimmed = String(source).trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  return fs.readFile(path.resolve(trimmed), "utf8");
};

const normalizeRule = (rule, index) => {
  const giftName = normalizeGiftName(rule.giftName ?? rule.giftTarget ?? rule.target ?? DEFAULT_GIFT_TARGET);
  const minCount = parsePositiveInt(rule.minCount ?? rule.giftCount ?? rule.count, DEFAULT_MIN_GIFT_COUNT);
  const mode = normalizeCountMode(rule.mode ?? DEFAULT_COUNT_MODE);
  const message = String(rule.message ?? MESSAGE);

  return {
    id: String(rule.id ?? `${index}:${giftName || "*"}:${minCount}:${mode}`),
    giftName,
    minCount,
    mode,
    message,
  };
};

const loadGiftRules = async () => {
  const raw = await readRulesSource(RULES_SOURCE);

  if (!raw) {
    return [normalizeRule({}, 0)];
  }

  const parsed = JSON.parse(raw);
  const rules = Array.isArray(parsed) ? parsed : parsed.rules || [parsed];

  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("礼物规则不能为空");
  }

  return rules.map(normalizeRule);
};

const ruleMatchesGift = (rule, giftName) => !rule.giftName || rule.giftName === "*" || rule.giftName === giftName;

const getTotalKey = (uid, rule, giftName) => `${uid}:${rule.id}:${giftName}`;

const findMatchedRule = (payload, uid) => {
  const giftName = normalizeGiftName(payload.giftName);
  const giftCount = getGiftCount(payload);
  let matchedGiftRule = null;

  for (const rule of giftRules) {
    if (!ruleMatchesGift(rule, giftName)) {
      continue;
    }

    matchedGiftRule = rule;
    let compareCount = giftCount;
    let totalCount = giftCount;

    if (rule.mode === "total") {
      const totalKey = getTotalKey(uid, rule, giftName);
      totalCount = (giftTotals.get(totalKey) || 0) + giftCount;
      giftTotals.set(totalKey, totalCount);
      compareCount = totalCount;
    }

    if (compareCount >= rule.minCount) {
      return {
        rule,
        giftName,
        giftCount,
        totalCount,
        compareCount,
      };
    }
  }

  return matchedGiftRule
    ? { skippedByCount: true, rule: matchedGiftRule, giftName, giftCount }
    : { skippedByGift: true, giftName, giftCount };
};

const renderMessage = (template, values) =>
  template.replace(/\{\{\s*(uid|uname|giftName|giftCount|totalCount|minCount|count)\s*\}\}/g, (_, key) => {
    if (key === "count") {
      return String(values.giftCount);
    }

    return String(values[key] ?? "");
  });

const formatProcessOutput = (stdout, stderr) => {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return output || "无输出";
};

const runBiliTest = (uid, message) => {
  const args = [BILI_TEST, uid, "--message", message, "--json"];

  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
      },
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

  const matched = findMatchedRule(payload, uid);
  if (matched.skippedByGift) {
    console.log(`⏭️ [Gift] ${matched.giftName || "未知礼物"}x${matched.giftCount} 未命中礼物规则，只记录不发送`);
    return;
  }

  if (matched.skippedByCount) {
    console.log(
      `⏭️ [Gift] ${matched.giftName || "未知礼物"}x${matched.giftCount} 未达到阈值 ${matched.rule.minCount}，只记录不发送`,
    );
    return;
  }

  const message = renderMessage(matched.rule.message, {
    uid,
    uname: payload.uname || "未知用户",
    giftName: matched.giftName,
    giftCount: matched.giftCount,
    totalCount: matched.totalCount,
    minCount: matched.rule.minCount,
  });

  if (DRY_RUN) {
    console.log(`🧪 [Gift] DRY_RUN 命中规则 ${matched.rule.id}，将向 UID ${uid} 发送: ${message}`);
    return;
  }

  console.log(
    `📨 [Gift] 命中规则 ${matched.rule.id}，正在向 ${payload.uname || "未知用户"} (UID: ${uid}) 发送私信...`,
  );

  let result;
  try {
    result = await runBiliTest(uid, message);
  } catch (error) {
    return {
      sent: false,
      uid,
      uname: payload.uname || "未知用户",
      giftName: matched.giftName,
      giftCount: matched.giftCount,
      code: null,
      message: error.message,
      error,
    };
  }

  if (result.code !== 0) {
    return {
      sent: false,
      uid,
      uname: payload.uname || "未知用户",
      giftName: matched.giftName,
      giftCount: matched.giftCount,
      code: result.code,
      message: result.message || JSON.stringify(result),
    };
  }

  sentUids.add(uid);
  await saveSentUids();
  console.log(`✅ [Gift] UID ${uid} 已发送并写入 ${SENT_UID_FILE}`);
  return { sent: true };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runConsumer = async () => {
  let isFirst = true;

  while (pendingQueue.length > 0) {
    if (!isFirst) {
      await sleep(SEND_INTERVAL_MS);
    }
    isFirst = false;

    const payload = pendingQueue.shift();

    try {
      await sendToGiftUser(payload);
    } catch (error) {
      console.error(`❌ [Gift] 处理失败: ${error.message}`);
    }
  }

  consumerRunning = false;
};

const queueGiftPayload = (payload) => {
  pendingQueue.push(payload);

  if (consumerRunning) {
    return;
  }

  consumerRunning = true;
  consumerPromise = runConsumer();
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

  consumerPromise.finally(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
};

const describeRule = (rule) =>
  `${rule.giftName || "任意礼物"} x>=${rule.minCount} (${rule.mode === "total" ? "用户累计" : "单次"})`;

const main = async () => {
  await fs.access(BILI_TEST);
  giftRules = await loadGiftRules();

  for (const uid of await loadSentUids()) {
    sentUids.add(uid);
  }

  console.log("🟢 [System] 礼物 UID 自动私信程序已启动");
  console.log(`🟢 [System] WebSocket: ${WS_URL}`);
  console.log(`🟢 [System] UID 记录: ${UID_LOG_FILE}`);
  console.log(`🟢 [System] 已发送记录: ${SENT_UID_FILE}`);
  console.log(`🟢 [System] 同 UID 只发送一次: ${SEND_ONCE ? "是" : "否"}`);
  console.log(`🟢 [System] 发送间隔: ${SEND_INTERVAL_MS}ms (串行，按抓取顺序)`);
  console.log(`🟢 [System] 私信规则: ${giftRules.map(describeRule).join("；")}`);

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
