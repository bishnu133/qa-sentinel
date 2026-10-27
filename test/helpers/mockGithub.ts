import { serve } from "./mocks.js";

/**
 * A fake GitHub REST API (no network). Field names follow GitHub's public REST documentation for issue comments, pull
 * requests, reactions and labels, written from the docs by hand; they have NOT been compared with a live GitHub.
 */
export interface GhComment {
  id: number;
  body: string;
  user: { login: string; id: number; type: string };
  html_url: string;
}

export interface GhPull {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  draft: boolean;
  html_url: string;
  merged_at: string | null;
  created_at: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  labels: { name: string }[];
}

export interface GhOptions {
  /** `GET /user` answers 403 "Resource not accessible by integration" like the workflow token does. */
  userForbidden?: boolean;
  /** Comments per page (for pagination tests). */
  pageSize?: number;
  /** Fail the first N requests with this status. */
  failFirst?: { n: number; status: number; headers?: Record<string, string> };
  /** Put the token in every error body (to prove it never reaches a message). */
  echoAuthInErrors?: boolean;
}

export async function githubMock(o: GhOptions = {}) {
  const me = { login: "qa-bot", id: 42, type: "User" };
  const actions = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
  const comments: GhComment[] = [];
  const pulls: GhPull[] = [];
  const reactions: Record<number, { content: string }[]> = {};
  const files: Record<number, { filename: string; status: string; additions: number; deletions: number }[]> = {};
  const headers: Record<string, string | undefined>[] = [];
  const bodies: string[] = [];
  let nextId = 1001;
  let failed = 0;
  const srv = await serve((req, url, raw) => {
    headers.push({ authorization: req.headers.authorization, accept: req.headers.accept, version: req.headers["x-github-api-version"] as string | undefined });
    bodies.push(raw);
    if (o.failFirst && failed < o.failFirst.n) {
      failed++;
      return { status: o.failFirst.status, headers: o.failFirst.headers, body: { message: "try later" } };
    }
    if (o.echoAuthInErrors && url.pathname.startsWith("/nope")) return { status: 422, body: { message: `bad credentials: ${req.headers.authorization}` } };
    const body = raw ? JSON.parse(raw) : {};
    const p = url.pathname;
    const method = req.method ?? "GET";
    const asMe = o.userForbidden ? actions : me;
    if (p === "/user") return o.userForbidden ? { status: 403, body: { message: "Resource not accessible by integration" } } : { body: me };
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)$/))) return { body: { full_name: m[1], permissions: { push: true } } };
    // issue comments of a pull request
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/))) {
      if (method === "GET") {
        const size = o.pageSize ?? 100;
        const page = Number(url.searchParams.get("page") ?? 1);
        const slice = comments.slice((page - 1) * size, page * size);
        const next = page * size < comments.length ? { link: `<http://${req.headers.host}${p}?per_page=100&page=${page + 1}>; rel="next", <http://${req.headers.host}${p}?per_page=100&page=9>; rel="last"` } : undefined;
        return { body: slice, headers: next };
      }
      const c: GhComment = { id: nextId++, body: body.body, user: asMe, html_url: `https://github.com/octo/orders/pull/${m[1]}#issuecomment-${nextId}` };
      comments.push(c);
      return { status: 201, body: c };
    }
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/)) && method === "PATCH") {
      const c = comments.find((x) => x.id === Number(m![1]));
      if (!c) return { status: 404, body: { message: "Not Found" } };
      if (c.user.id !== asMe.id) return { status: 403, body: { message: "not your comment" } };
      c.body = body.body;
      return { body: c };
    }
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions$/))) return reactions[Number(m[1])] ? { body: reactions[Number(m[1])] } : { status: 404, body: { message: "Not Found" } };
    // labels
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/)) && method === "POST") {
      const pr = pulls.find((x) => x.number === Number(m![1]));
      if (!pr) return { status: 404, body: { message: "Not Found" } };
      for (const l of body.labels as string[]) if (!pr.labels.some((x) => x.name === l)) pr.labels.push({ name: l });
      return { body: pr.labels };
    }
    // issues list (open pull requests carrying a label)
    if (p.match(/^\/repos\/[^/]+\/[^/]+\/issues$/) && method === "GET") {
      const label = url.searchParams.get("labels");
      return { body: pulls.filter((x) => x.state === "open" && (!label || x.labels.some((l) => l.name === label))).map((x) => ({ number: x.number, html_url: x.html_url, title: x.title, pull_request: { url: "x" } })) };
    }
    // pull requests
    if ((m = p.match(/^\/repos\/([^/]+)\/[^/]+\/pulls$/))) {
      if (method === "GET") {
        const head = url.searchParams.get("head");
        const base = url.searchParams.get("base");
        const state = url.searchParams.get("state") ?? "open";
        return { body: pulls.filter((x) => (!head || head === `${m![1]}:${x.head.ref}`) && (!base || base === x.base.ref) && (state === "all" || state === x.state)) };
      }
      const n = pulls.length + 7;
      const pr: GhPull = { number: n, state: "open", title: body.title, body: body.body, draft: !!body.draft, html_url: `https://github.com/octo/tests/pull/${n}`, merged_at: null, created_at: new Date(Date.UTC(2026, 0, n)).toISOString(), head: { ref: body.head, sha: "h".repeat(40) }, base: { ref: body.base, sha: "b".repeat(40) }, labels: [] };
      pulls.push(pr);
      return { status: 201, body: pr };
    }
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
      const pr = pulls.find((x) => x.number === Number(m![1]));
      if (!pr) return { status: 404, body: { message: "Not Found" } };
      if (method === "PATCH") {
        pr.title = body.title ?? pr.title;
        pr.body = body.body ?? pr.body;
      }
      return { body: pr };
    }
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files$/))) {
      const all = files[Number(m[1])] ?? [];
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = all.slice((page - 1) * 2, page * 2);
      return { body: slice, headers: page * 2 < all.length ? { link: `<http://${req.headers.host}${p}?per_page=100&page=${page + 1}>; rel="next"` } : undefined };
    }
    return { status: 404, body: { message: "Not Found", path: p } };
  });
  return { ...srv, me, actions, comments, pulls, reactions, files, headers, bodies };
}
