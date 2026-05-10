import httpx
import time
import urllib.parse
import hashlib
import json
import asyncio
import sys
import os
import argparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# ================= 1. 核心凭证与参数 =================
SESSDATA = os.getenv("BILI_SESSDATA", "edee9281%2C1793724896%2C22577%2A52CjDCXJZhyiLoVvMZ8YQq0wg2GaSrBH2tWgT3EpQEfU-cqt53dxsxsWflrlgNHtF6AaESVkp0T2RsWTRpZUVDcUktSk5UOThkTzRPS1dhWlVYMlRKRU5QYTByZzN4SS1RQ3VmOGxhejFfdDA5a1RRdG00VDhHWERWWllGSTFRSktRek12dmtNWlNRIIEC")
BILI_JCT = os.getenv("BILI_JCT", "6c7aa83ceaaebf8045934cc9df18c871")

SENDER_UID = int(os.getenv("BILI_SENDER_UID", "2191386"))     # 你的 UID (抓包提供)
RECEIVER_UID = int(os.getenv("BILI_RECEIVER_UID", "4805538"))  # 默认目标 UID (抓包提供)
DEV_ID = os.getenv("BILI_DEV_ID", "CBFAC15B-2076-458C-8D07-F7A6B42D6D2F") # 你的设备指纹 (抓包提供)
DEFAULT_MESSAGE = os.getenv("BILI_MESSAGE", "你好，这是一条脱离客户端发送的自动化测试消息。")

# ================= 2. WBI 签名加密算法 =================
# B站混淆在前端 JS 里的“魔法表”，用于计算 mixin_key
mixinKeyEncTab = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
]

def get_mixin_key(orig: str) -> str:
    # 根据魔法表打乱字符串并截取前32位
    return ''.join([orig[i] for i in mixinKeyEncTab])[:32]

def encode_wbi(params: dict, mixin_key: str) -> str:
    # 注入时间戳
    params['wts'] = round(time.time())
    # 按键名字典序排序参数
    query_list = []
    for k in sorted(params.keys()):
        v = params[k]
        # URL 编码
        query_list.append(f"{k}={urllib.parse.quote(str(v), safe='')}")
    query_str = '&'.join(query_list)
    # MD5 哈希计算 w_rid
    md5 = hashlib.md5((query_str + mixin_key).encode('utf-8')).hexdigest()
    return query_str + f"&w_rid={md5}"

# ================= 3. 主请求逻辑 =================
async def send_message(receiver_uid: int, content: str = DEFAULT_MESSAGE) -> dict:
    cookies = {
        "SESSDATA": SESSDATA,
        "bili_jct": BILI_JCT
    }
    
    # 伪装成浏览器，避免被拦截
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://message.bilibili.com/",
        "Origin": "https://message.bilibili.com"
    }

    async with httpx.AsyncClient(cookies=cookies, headers=headers, timeout=15) as client:
        # 第一步：访问导航接口，获取计算 WBI 必备的动态 img_key 和 sub_key
        nav_resp = await client.get("https://api.bilibili.com/x/web-interface/nav")
        nav_resp.raise_for_status()
        nav_data = nav_resp.json()
        
        if nav_data.get('code') != 0:
            raise RuntimeError(f"登录凭证无效，获取密钥失败: {nav_data}")

        wbi_img = nav_data['data']['wbi_img']
        img_key = wbi_img['img_url'].split('/')[-1].split('.')[0]
        sub_key = wbi_img['sub_url'].split('/')[-1].split('.')[0]
        mixin_key = get_mixin_key(img_key + sub_key)

        # 第二步：构造 WBI 签名的 URL（这完美还原了你抓包记录里的 URL 参数集）
        url_params = {
            "w_sender_uid": SENDER_UID,
            "w_receiver_id": receiver_uid,
            "w_dev_id": DEV_ID
        }
        signed_query_str = encode_wbi(url_params, mixin_key)
        target_url = f"https://api.vc.bilibili.com/web_im/v1/web_im/send_msg?{signed_query_str}"

        # 第三步：构造 POST 的表单数据 (Payload)
        msg_content = {"content": content}
        form_data = {
            "msg[sender_uid]": SENDER_UID,
            "msg[receiver_id]": receiver_uid,
            "msg[receiver_type]": 1,      # 单聊
            "msg[msg_type]": 1,           # 文本类型
            "msg[msg_status]": 0,
            "msg[content]": json.dumps(msg_content, ensure_ascii=True), # 内容必须是 JSON 字符串
            "msg[timestamp]": int(time.time()),
            "msg[new_face_version]": 0,
            "msg[dev_id]": DEV_ID,
            "csrf": BILI_JCT,
            "csrf_token": BILI_JCT
        }

        # 第四步：发送请求
        resp = await client.post(target_url, data=form_data)
        resp.raise_for_status()
        return resp.json()

def parse_args():
    parser = argparse.ArgumentParser(description="向指定 B 站 UID 发送私信。")
    parser.add_argument("receiver_uid", nargs="?", type=int, default=RECEIVER_UID, help="接收方 UID")
    parser.add_argument("-m", "--message", default=DEFAULT_MESSAGE, help="要发送的私信内容")
    parser.add_argument("--json", action="store_true", help="只输出接口返回 JSON，方便自动化程序解析")
    return parser.parse_args()

async def main():
    args = parse_args()

    if not args.json:
        print("🚀 启动纯 HTTP 自动化测试脚本...")
        print(f"正在向 UID: {args.receiver_uid} 发送私信...")

    try:
        result = await send_message(args.receiver_uid, args.message)
    except Exception as error:
        if args.json:
            print(json.dumps({"code": -1, "message": str(error)}, ensure_ascii=True))
        else:
            print(f"❌ 发送失败: {error}")
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=True))
    else:
        print("\n🎉 发送结果:")
        print(result)

    return 0 if result.get("code") == 0 else 1

if __name__ == "__main__":
    if sys.platform == 'win32':
        import warnings
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    
    raise SystemExit(asyncio.run(main()))
