(() => {
  const CHANNEL_NAME = "bili_gift_channel";
  const TARGET_GIFT = "人气票";
  const LIST_SELECTOR = ".chat-history-list";
  const ITEM_SELECTOR = ".gift-item";
  const GIFT_NAME_SELECTOR = ".gift-name";
  const GIFT_COUNT_SELECTORS = [".gift-count", ".gift-num", ".gift-amount", ".gift-number", ".count", ".num"];

  if (window.__biliGiftCapture?.stop) {
    window.__biliGiftCapture.stop();
  }

  const channel = new BroadcastChannel(CHANNEL_NAME);
  const processedNodes = new WeakSet();

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

  const buildPayload = (giftNode) => {
    const giftName = giftNode.querySelector(GIFT_NAME_SELECTOR)?.textContent?.trim();

    if (giftName !== TARGET_GIFT) {
      return null;
    }

    return {
      uid: giftNode.getAttribute("data-uid"),
      uname: giftNode.getAttribute("data-uname")?.trim() || "未知用户",
      giftName,
      giftCount: getGiftCount(giftNode),
      capturedAt: new Date().toISOString(),
    };
  };

  const handleGiftNode = (giftNode) => {
    if (processedNodes.has(giftNode)) {
      return;
    }

    processedNodes.add(giftNode);

    const payload = buildPayload(giftNode);
    if (!payload) {
      return;
    }

    console.log(`[抓取端] 抓取到: ${payload.uname} -> ${payload.giftName}`);
    channel.postMessage(payload);
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
    for (const mutation of mutationsList) {
      if (mutation.type !== "childList" || mutation.addedNodes.length === 0) {
        continue;
      }

      mutation.addedNodes.forEach((node) => {
        collectGiftNodes(node).forEach(handleGiftNode);
      });
    }
  });

  const start = () => {
    const targetNode = document.querySelector(LIST_SELECTOR) || document.body;

    observer.observe(targetNode, {
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
