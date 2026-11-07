import { DurableObject } from "cloudflare:workers";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "Content-Type": "application/json;charset=utf-8" },
  });

export class BatteryRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      for (const old of this.ctx.getWebSockets()) {
        try { old.close(1000, "replaced"); } catch (e) {}
      }
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return json({ online: false, error: "A手机未连接" }, 503);

    let action = "";
    if (url.pathname === "/query") action = "get_battery";
    else action = url.searchParams.get("action") || "";
    if (action !== "get_battery" && action !== "open_app")
      return json({ error: "不支持的指令" }, 400);

    const id = crypto.randomUUID();
    const msg = {
      id,
      action,
      name: url.searchParams.get("name") || "",
      pkg: url.searchParams.get("pkg") || "",
    };

    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, 15000);
      this.pending.set(id, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
      try {
        sockets[0].send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: "发送失败" });
      }
    });

    if (!result) return json({ online: true, ok: false, error: "A手机未响应" }, 504);
    return json({ online: true, ...result });
  }

  webSocketMessage(ws, message) {
    let d;
    try { d = JSON.parse(message); } catch (e) { return; }
    const f = this.pending.get(d.id);
    if (f) {
      this.pending.delete(d.id);
      f(d);
    }
  }

  webSocketClose(ws, code, reason) {
    try { ws.close(1000, "bye"); } catch (e) {}
  }

  webSocketError(ws, err) {}
}

const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:sans-serif;padding:24px">
<h2>A 手机</h2>
<input id="k" placeholder="查询密钥" style="padding:10px;width:100%;box-sizing:border-box"><br><br>
<button id="b1" style="padding:12px 20px">查电量</button><br><br>
<input id="n" value="乔安智联" style="padding:10px;width:100%;box-sizing:border-box"><br><br>
<button id="b2" style="padding:12px 20px">打开这个App</button>
<pre id="r" style="white-space:pre-wrap;margin-top:20px"></pre>
<script>
var K=document.getElementById("k"),N=document.getElementById("n"),R=document.getElementById("r");
K.value=localStorage.getItem("k")||"";
async function go(path){
  localStorage.setItem("k",K.value);
  R.textContent="请求中…";
  try{
    var res=await fetch(path);
    R.textContent=JSON.stringify(await res.json(),null,2);
  }catch(e){R.textContent="请求失败";}
}
document.getElementById("b1").onclick=function(){go("/query?key="+encodeURIComponent(K.value));};
document.getElementById("b2").onclick=function(){go("/cmd?action=open_app&name="+encodeURIComponent(N.value)+"&key="+encodeURIComponent(K.value));};
</script>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const key = url.searchParams.get("key") || "";
    const stub = env.BATTERY.get(env.BATTERY.idFromName("main"));

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      if (url.searchParams.get("role") !== "device" || key !== env.DEVICE_KEY)
        return new Response("forbidden", { status: 403 });
      return stub.fetch(req);
    }

    if (url.pathname === "/query" || url.pathname === "/cmd") {
      if (key !== env.BROWSER_KEY) return json({ error: "forbidden" }, 403);
      return stub.fetch(req);
    }

    if (url.pathname === "/") {
      return new Response(PAGE, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    return new Response("not found", { status: 404 });
  },
};
