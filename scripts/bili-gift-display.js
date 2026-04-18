(() => {
  const CHANNEL_NAME = "bili_gift_channel";

  if (window.__biliGiftDisplay?.stop) {
    window.__biliGiftDisplay.stop();
  }

  const channel = new BroadcastChannel(CHANNEL_NAME);
  const messages = [];

  const onMessage = (event) => {
    const payload = event.data;
    messages.push(payload);
    console.log("[展示端] 收到礼物消息:", payload);
  };

  channel.addEventListener("message", onMessage);

  const stop = () => {
    channel.removeEventListener("message", onMessage);
    channel.close();
    delete window.__biliGiftDisplay;
    console.log("[展示端] 已停止监听。");
  };

  window.__biliGiftDisplay = {
    messages,
    stop,
  };

  console.log(`[展示端] 已启动，正在监听频道: ${CHANNEL_NAME}`);
})();
