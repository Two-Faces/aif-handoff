import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { randomInt } from "node:crypto";

export type HttpFixtureMode =
  | "json"
  | "sse"
  | "abort"
  | "timeout"
  | "callback"
  | "crash"
  | "http_error"
  | "truncated"
  | "malformed"
  | "overflow"
  | "proxy"
  | "redirect";
export async function httpCompletionFixture(
  mode: HttpFixtureMode,
  provider: "codex" | "openrouter",
) {
  const requests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
  }> = [];
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const sockets = new Set<Socket>();
  let proxyRequests = 0,
    proxyAuth = false;
  const usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.01 };
  const choice = (text: string | null, finish: string | null) => ({
    index: 0,
    delta: { content: text },
    finish_reason: finish,
  });
  const server = createServer(async (req, res) => {
    try {
      res.once("close", disconnected);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (mode === "redirect") {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/leak` });
        res.end();
        return;
      }
      if (mode === "http_error") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "5" });
        res.end('{"error":{"message":"PRIVATE_UPSTREAM_BODY"}}');
        return;
      }
      if (mode === "json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "request",
            choices: [{ index: 0, message: { content: "Готово 🧪" }, finish_reason: "stop" }],
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": heartbeat\r\n\r\n");
      if (mode === "malformed") {
        res.end("data: PRIVATE_UPSTREAM_BODY\n\n");
        return;
      }
      if (mode === "overflow") {
        res.end(":" + "x".repeat(17 * 1024 * 1024));
        return;
      }
      // A split UTF-8 sequence plus SSE multi-line data/CRLF exercise real parsing.
      const frame = Buffer.from(
        'data:{"id":"request",\r\ndata: "choices":' +
          JSON.stringify([choice("Готово 🧪", null)]) +
          "}\r\n\r\n",
      );
      const offset = frame.indexOf(Buffer.from("🧪")) + 1;
      res.write(frame.subarray(0, offset));
      setImmediate(() => {
        if (res.destroyed) return;
        res.write(frame.subarray(offset));
        if (["abort", "timeout", "callback", "crash"].includes(mode)) return;
        res.write(
          "data: " + JSON.stringify({ id: "request", choices: [choice(null, "stop")] }) + "\n\n",
        );
        res.write(
          "data: " +
            JSON.stringify({
              id: "request",
              choices: provider === "openrouter" ? [choice("", "stop")] : [],
              usage,
            }) +
            "\n\n",
        );
        res.end(mode === "truncated" ? "" : "data: [DONE]");
      });
    } catch {
      res.destroy();
    }
  });
  const listen = async (target: Server) => {
    target.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => sockets.delete(socket));
    });
    // Some hosts assign port 0 from 1024 upwards, including fetch's forbidden
    // ports. Bind directly in the high ephemeral range; no release/rebind race.
    // Windows also reserves port ranges that reject bind with EACCES.
    let listening = false;
    for (let attempt = 0; attempt < 32 && !listening; attempt++) {
      listening = await new Promise<boolean>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          target.off("listening", onListening);
          if (
            error.code === "EADDRINUSE" ||
            (process.platform === "win32" && error.code === "EACCES")
          )
            resolve(false);
          else reject(error);
        };
        const onListening = () => {
          target.off("error", onError);
          resolve(true);
        };
        target.once("error", onError);
        target.once("listening", onListening);
        target.listen(randomInt(49152, 65536), "127.0.0.1");
      });
    }
    if (!listening) throw new Error("No high loopback fixture port available");
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("fixture address");
    return address.port;
  };
  const port = await listen(server);
  const proxy = createServer();
  proxy.on("connect", (req, client, head) => {
    if (req.url !== `127.0.0.1:${port}`) {
      client.destroy();
      return;
    }
    proxyRequests++;
    proxyAuth =
      req.headers["proxy-authorization"] ===
      "Basic " + Buffer.from("fixture:secret").toString("base64");
    const upstream = createConnection({ host: "127.0.0.1", port }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    upstream.once("close", () => sockets.delete(upstream));
    client.once("close", () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    proxyUrl: `http://fixture:secret@127.0.0.1:${proxyPort}`,
    requests,
    closed,
    get proxyRequests() {
      return proxyRequests;
    },
    get proxyAuth() {
      return proxyAuth;
    },
    get listening() {
      return server.listening;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [server, proxy].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      );
    },
  };
}
