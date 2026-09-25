"""Bridge giả: heartbeat, trả QR rồi 'đã quét' rồi active khi nhận session.login; gửi danh bạ nhóm; nhận lệnh 'send' từ file."""
import asyncio, base64, json, os, sys, time
sys.path.insert(0, os.environ.get("GH_API_DIR", os.path.join(os.path.dirname(__file__), "../../api")))
from redis.asyncio import Redis
from gh.chassis.bus import EventBus, BRIDGE_CONTROL, BRIDGE_STATUS, BRIDGE_DIRECTORY, BRIDGE_INBOUND
from gh import crypto

ORG = os.environ["ORG"]
QR = "data:image/svg+xml;base64," + base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><rect x="20" y="20" width="60" height="60"/><rect x="120" y="20" width="60" height="60"/><rect x="20" y="120" width="60" height="60"/></svg>').decode()

async def main():
    r = Redis.from_url(os.environ["GH_REDIS_URL"]); bus = EventBus(r, 10000)
    async def hb():
        while True:
            await r.set("gh:bridge:heartbeat", str(time.time()), ex=30); await asyncio.sleep(5)
    asyncio.create_task(hb())
    await bus.publish(BRIDGE_STATUS, "bridge.hello", {}, actor="bridge", org_id=ORG)
    async def on_control(ev):
        p = ev.payload
        if ev.type != "session.login": return
        sid, ch = p["session_id"], p["channel"]
        await bus.publish(BRIDGE_STATUS, "session.qr", {"session_id": sid, "image": QR,
                          "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 60))},
                          actor="bridge", org_id=ORG)
        await asyncio.sleep(float(os.environ.get("SCAN_AFTER", "6")))
        await bus.publish(BRIDGE_STATUS, "session.scanned", {"session_id": sid}, actor="bridge", org_id=ORG)
        await asyncio.sleep(2)
        cred = crypto.transport_encrypt(json.dumps({"imei": "x", "cookie": [], "userAgent": "UA"}).encode(), f"{ch}:{sid}")
        await bus.publish(BRIDGE_STATUS, "session.active", {"session_id": sid, "credential": cred,
                          "account": {"id": "acc-1", "name": "Zalo Sếp"}}, actor="bridge", org_id=ORG)
        await bus.publish(BRIDGE_DIRECTORY, "groups", {"channel": ch, "groups": [
            {"external_id": "g-si", "name": "Chợ thép sỉ miền Nam", "member_count": 124, "members": [
                {"external_id": "u-lan", "name": "Nguyễn Thị Lan", "phone": "0912345678"},
                {"external_id": "u-tung", "name": "Trần Văn Tùng"}]},
            {"external_id": "g-noibo", "name": "Nội bộ kinh doanh", "member_count": 9},
            {"external_id": "g-dt", "name": "Đối tác vận tải", "member_count": 31}]}, actor="bridge", org_id=ORG)
    stop = asyncio.Event()
    await bus.run(BRIDGE_CONTROL, "fakebridge", "fb-1", on_control, stop)

asyncio.run(main())
