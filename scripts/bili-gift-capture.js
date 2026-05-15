(() => {
  const CHANNEL_NAME = "bili_gift_channel";
  const TARGET_GIFT = "人气票";
  const LIST_SELECTOR = ".chat-history-list";
  const ITEM_SELECTOR = ".gift-item";
  const GIFT_NAME_SELECTOR = ".gift-name";
  const GIFT_COUNT_SELECTORS = [".gift-count", ".gift-num", ".gift-amount", ".gift-number", ".count", ".num"];
  const UID_ATTRIBUTES = ["data-uid", "data-userid", "data-user-id", "data-mid"];

  if (window.__biliGiftCapture?.stop) {
    window.__biliGiftCapture.stop();
  }

  const channel = new BroadcastChannel(CHANNEL_NAME);
  const giftNodeCounts = new WeakMap();

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

    if (giftName !== TARGET_GIFT) {
      return null;
    }

    return {
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
    if (!payload) {
      return;
    }

    giftNodeCounts.set(giftNode, { key: giftKey, count: giftCount });
    console.log(`[抓取端] 抓取到: ${payload.uname} -> ${payload.giftName} x${payload.giftCount}`);
    channel.postMessage(payload);
  };

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

    console.log(
      `[抓取端] 已启动，正在监听礼物: ${TARGET_GIFT}，广播频道: ${CHANNEL_NAME}`,
    );
  };

  const stop = () => {
    observer.disconnect();
    channel.close();
    delete window.__biliGiftCapture;
    console.log("[抓取端] 已停止监听。");
  };

  window.__biliGiftCapture = {
    stop,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
