import http from "node:http";

export interface MockUser {
  accountId?: string;
  name?: string;
  key?: string;
  displayName?: string;
  accountType?: string;
}
export interface MockComment {
  id: string;
  body: string;
  author: MockUser;
  created: string;
  visibility?: { type: string; value: string };
}

/** The user qa-sentinel's token belongs to in these tests. */
export const BOT: MockUser = { accountId: "5bot0000000000000001", displayName: "qa-sentinel" };
export const DANA: MockUser = { accountId: "5dana000000000000002", displayName: "Dana Tester", accountType: "atlassian" };
export const EVE: MockUser = { accountId: "5eve0000000000000003", displayName: "Eve Other", accountType: "atlassian" };

/**
 * A mock Jira (REST v2) on 127.0.0.1:0 that keeps comments with authors in memory. Writes by the token user are
 * recorded in `touched` with the author of the comment they hit, so a test can assert that no PUT or DELETE ever
 * targets someone else's comment. Comment pages are 2 long to exercise paging.
 */
export async function mockJira(o: { issues?: Record<string, Record<string, unknown>>; comments?: Record<string, MockComment[]>; me?: MockUser | null } = {}) {
  const comments: Record<string, MockComment[]> = o.comments ?? {};
  const touched: { method: string; id: string; author: MockUser }[] = [];
  const calls: string[] = [];
  let seq = 100;
  let clock = Date.parse("2026-10-20T08:00:00Z");
  const next = () => new Date((clock += 60_000)).toISOString().replace("Z", "+0000");
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      calls.push(`${req.method} ${url.pathname}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status === 204 ? "" : JSON.stringify(body));
      };
      if (url.pathname === "/rest/api/2/myself") return o.me === null ? send(403, {}) : send(200, o.me ?? BOT);
      const cm = url.pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)\/comment(?:\/([^/]+))?$/);
      if (cm) {
        const key = decodeURIComponent(cm[1]);
        const list = (comments[key] ??= []);
        if (req.method === "GET") {
          const start = Number(url.searchParams.get("startAt") ?? 0);
          const max = Math.min(Number(url.searchParams.get("maxResults") ?? 100), 2);
          return send(200, { startAt: start, total: list.length, comments: list.slice(start, start + max) });
        }
        const payload = raw ? JSON.parse(raw) : {};
        if (req.method === "POST") {
          const c: MockComment = { id: String(++seq), body: payload.body, author: o.me ?? BOT, created: next(), ...(payload.visibility ? { visibility: payload.visibility } : {}) };
          list.push(c);
          return send(201, c);
        }
        const hit = list.find((c) => c.id === cm[2]);
        if (!hit) return send(404, {});
        touched.push({ method: req.method ?? "", id: hit.id, author: hit.author });
        if (req.method === "PUT") {
          hit.body = payload.body;
          if (payload.visibility) hit.visibility = payload.visibility;
          return send(200, hit);
        }
        if (req.method === "DELETE") {
          list.splice(list.indexOf(hit), 1);
          return send(204, {});
        }
      }
      const issue = url.pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)$/);
      if (issue && req.method === "GET") {
        const key = decodeURIComponent(issue[1]);
        return o.issues?.[key] ? send(200, { key, fields: o.issues[key] }) : send(404, {});
      }
      if (/\/properties\//.test(url.pathname)) return send(404, {});
      send(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    comments,
    touched,
    calls,
    ctx: { baseUrl, authHeader: "Basic x" },
    baseUrl,
    add(key: string, body: string, author: MockUser = DANA, extra: Partial<MockComment> = {}): MockComment {
      const c: MockComment = { id: String(++seq), body, author, created: next(), ...extra };
      (comments[key] ??= []).push(c);
      return c;
    },
    /** Writes (PUT/DELETE) that hit a comment the token user did not write. */
    foreignWrites: () => touched.filter((t) => t.author.accountId !== (o.me ?? BOT).accountId),
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
