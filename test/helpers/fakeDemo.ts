// A small fake Jira and a small fake GitLab (plain node:http, in memory), enough for the demo kit scripts.
// They keep every request, so a test can check that nothing was written. Only made-up keys and text.
import http from "node:http";
import { randomBytes } from "node:crypto";

type Req = { method: string; path: string; body: any };
const json = (res: http.ServerResponse, status: number, data: unknown) => {
  const text = data === undefined ? "" : JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
};
async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const t = Buffer.concat(chunks).toString("utf8");
  try {
    return t ? JSON.parse(t) : undefined;
  } catch {
    return t;
  }
}
const listen = (server: http.Server) => new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as any).port}`)));

// ------------------------------------------------------------------------------------------- Jira

export interface FakeComment {
  id: string;
  body: string;
  author: { accountId: string; displayName: string };
}
export interface FakeIssue {
  key: string;
  fields: { summary: string; description: string; status: { name: string }; labels: string[]; issuetype: { name: string }; reporter: { accountId: string }; attachment: { id: string; filename: string; author: { accountId: string } }[] };
  comments: FakeComment[];
  props: Record<string, unknown>;
  attachments: string[];
}

export async function startFakeJira(opts: { project?: string; token?: string; cloudSearch?: boolean } = {}) {
  const project = opts.project ?? "DEMO";
  const issues = new Map<string, FakeIssue>();
  const requests: Req[] = [];
  const links: any[] = [];
  const deletedAttachments: string[] = [];
  let n = 0;
  let cid = 0;
  const STATUSES = ["To Do", "In Progress", "In Review", "Done"];
  const ME = { accountId: "bot-1", displayName: "Demo Bot" };
  const OTHER = { accountId: "person-2", displayName: "A Person" };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readBody(req);
    requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, body });
    if (opts.token && req.headers.authorization !== opts.token) return json(res, 401, { errorMessages: ["bad login"] });
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (p === "/rest/api/2/myself") return json(res, 200, ME);
    let g: RegExpMatchArray | null;
    if ((g = p.match(/^\/rest\/api\/2\/project\/([^/]+)$/))) return json(res, 200, { key: g[1], issueTypes: [{ name: "Story" }, { name: "Bug" }, { name: "Sub-task", subtask: true }] });
    if (p === "/rest/api/2/issue" && m === "POST") {
      const key = `${body.fields.project.key}-${++n}`;
      issues.set(key, { key, fields: { summary: body.fields.summary, description: body.fields.description, status: { name: "To Do" }, labels: body.fields.labels ?? [], issuetype: body.fields.issuetype, reporter: ME, attachment: [] }, comments: [], props: {}, attachments: [] });
      return json(res, 201, { key });
    }
    if ((p === "/rest/api/2/search" || (p === "/rest/api/3/search/jql" && opts.cloudSearch)) && m === "GET") {
      // Issues that do not carry the demo label (the only query the kit asks).
      const others = [...issues.values()].filter((i) => !i.fields.labels.includes("qa-sentinel-demo")).slice(0, Number(url.searchParams.get("maxResults") ?? 50));
      return json(res, 200, { issues: others.map((i) => ({ key: i.key, fields: { labels: i.fields.labels } })) });
    }
    if (p === "/rest/api/2/issueLink" && m === "POST") {
      links.push(body);
      return json(res, 201, undefined);
    }
    if ((g = p.match(/^\/rest\/api\/2\/attachment\/([^/]+)$/)) && m === "DELETE") {
      deletedAttachments.push(g[1]);
      return json(res, 204, undefined);
    }
    if ((g = p.match(/^\/rest\/api\/2\/issue\/([^/]+)(\/.*)?$/))) {
      const issue = issues.get(g[1]);
      if (!issue) return json(res, 404, { errorMessages: ["Issue does not exist"] });
      const rest = g[2] ?? "";
      if (rest === "" && m === "GET") return json(res, 200, { key: issue.key, fields: issue.fields });
      if (rest === "" && m === "DELETE") {
        issues.delete(issue.key);
        return json(res, 204, undefined);
      }
      if (rest === "/transitions" && m === "GET") return json(res, 200, { transitions: STATUSES.filter((s) => s !== issue.fields.status.name).map((s) => ({ id: String(STATUSES.indexOf(s)), name: s, to: { name: s } })) });
      if (rest === "/transitions" && m === "POST") {
        issue.fields.status = { name: STATUSES[Number(body.transition.id)] };
        return json(res, 204, undefined);
      }
      if (rest === "/comment" && m === "GET") {
        const start = Number(url.searchParams.get("startAt") ?? 0);
        const max = Number(url.searchParams.get("maxResults") ?? 50);
        return json(res, 200, { total: issue.comments.length, comments: issue.comments.slice(start, start + max) });
      }
      if ((g = rest.match(/^\/comment\/([^/]+)$/)) && m === "DELETE") {
        issue.comments = issue.comments.filter((c) => c.id !== g![1]);
        return json(res, 204, undefined);
      }
      if ((g = rest.match(/^\/properties\/([^/]+)$/))) {
        const name = decodeURIComponent(g[1]);
        if (m === "GET") return name in issue.props ? json(res, 200, { key: name, value: issue.props[name] }) : json(res, 404, { errorMessages: ["no such property"] });
        if (m === "DELETE") {
          if (!(name in issue.props)) return json(res, 404, {});
          delete issue.props[name];
          return json(res, 204, undefined);
        }
      }
    }
    json(res, 404, { errorMessages: [`fake jira: no route ${m} ${p}`] });
  });
  const url = await listen(server);
  return {
    url,
    project,
    issues,
    requests,
    links,
    deletedAttachments,
    ME,
    OTHER,
    writes: () => requests.filter((r) => r.method !== "GET"),
    comment(key: string, body: string, who: "me" | "other" = "me") {
      const c = { id: String(++cid), body, author: who === "me" ? ME : OTHER };
      issues.get(key)!.comments.push(c);
      return c.id;
    },
    setStatus(key: string, name: string) {
      issues.get(key)!.fields.status = { name };
    },
    addAttachment(key: string, id: string, filename: string, who: "me" | "other" = "me") {
      issues.get(key)!.fields.attachment.push({ id, filename, author: who === "me" ? ME : OTHER });
    },
    /** An issue that the demo does not know about. */
    addForeign(key: string) {
      issues.set(key, { key, fields: { summary: "other", description: "", status: { name: "To Do" }, labels: [], issuetype: { name: "Story" }, reporter: OTHER, attachment: [] }, comments: [], props: {}, attachments: [] });
    },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

// ------------------------------------------------------------------------------------------- GitLab

interface Commit {
  id: string;
  message: string;
  parent_ids: string[];
  files: Record<string, string>;
}
interface FProject {
  id: number;
  path: string;
  empty: boolean;
  commits: Map<string, Commit>;
  branches: Map<string, { head: string; protected: boolean }>;
  tags: Map<string, string>;
  mrs: any[];
  notes: Map<number, any[]>;
  nextIid: number;
  pipelines: { id: number; status: string }[];
  mergeChecks: number; // how many times a merge request still says "checking"
}

export async function startFakeGitlab(opts: { token?: string } = {}) {
  const projects = new Map<string, FProject>();
  const requests: Req[] = [];
  const ME = { id: 7, username: "demo-bot" };
  const OTHER = { id: 8, username: "someone-else" };
  let nid = 100;
  let nnote = 1000;
  const sha = () => randomBytes(20).toString("hex");

  const get = (p: string) => projects.get(p);
  const headFiles = (pr: FProject, branch: string) => pr.commits.get(pr.branches.get(branch)!.head)!.files;
  const commit = (pr: FProject, branch: string, message: string, files: Record<string, string>, extraParent?: string) => {
    const parent = pr.branches.get(branch)?.head;
    const id = sha();
    pr.commits.set(id, { id, message, parent_ids: [parent, extraParent].filter(Boolean) as string[], files });
    pr.branches.set(branch, { head: id, protected: pr.branches.get(branch)?.protected ?? false });
    return id;
  };
  const logOf = (pr: FProject, branch: string) => {
    const out: Commit[] = [];
    let id: string | undefined = pr.branches.get(branch)?.head;
    while (id) {
      const c = pr.commits.get(id)!;
      out.push(c);
      id = c.parent_ids[0];
    }
    return out;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readBody(req);
    const m = req.method ?? "GET";
    requests.push({ method: m, path: url.pathname + url.search, body });
    if (opts.token && req.headers["private-token"] !== opts.token) return json(res, 401, { message: "401 Unauthorized" });
    const p = url.pathname.replace(/^\/api\/v4/, "");
    if (p === "/user") return json(res, 200, ME);
    const g = p.match(/^\/projects\/([^/]+)(\/.*)?$/);
    if (!g) return json(res, 404, { message: "404 Not found" });
    const pr = get(decodeURIComponent(g[1])) ?? [...projects.values()].find((x) => String(x.id) === g[1]);
    if (!pr) return json(res, 404, { message: "404 Project Not Found" });
    const rest = g[2] ?? "";
    const page = Number(url.searchParams.get("page") ?? 1);
    const per = Number(url.searchParams.get("per_page") ?? 20);
    const paged = (arr: any[]) => json(res, 200, arr.slice((page - 1) * per, page * per));
    if (rest === "") return json(res, 200, { id: pr.id, path_with_namespace: pr.path, empty_repo: pr.empty });
    let r: RegExpMatchArray | null;
    if ((r = rest.match(/^\/repository\/tags\/(.+)$/))) {
      const id = pr.tags.get(decodeURIComponent(r[1]));
      return id ? json(res, 200, { name: decodeURIComponent(r[1]), commit: { id } }) : json(res, 404, { message: "404 Tag Not Found" });
    }
    if (rest.startsWith("/pipelines") && m === "GET") return paged(pr.pipelines.filter((x) => x.status === url.searchParams.get("status")));
    if ((r = rest.match(/^\/pipelines\/(\d+)\/cancel$/)) && m === "POST") {
      const pl = pr.pipelines.find((x) => x.id === Number(r![1]));
      if (pl) pl.status = "canceled";
      return json(res, 200, pl ?? {});
    }

    if (rest === "/repository/branches" && m === "GET") {
      const s = url.searchParams.get("search");
      const prefix = s?.startsWith("^") ? s.slice(1) : s;
      return paged([...pr.branches.entries()].filter(([n]) => !prefix || n.startsWith(prefix)).map(([name, b]) => ({ name, protected: b.protected, commit: { id: b.head } })));
    }
    if (rest === "/repository/branches" && m === "POST") {
      if (pr.branches.has(body.branch)) return json(res, 400, { message: "Branch already exists" });
      const from = pr.branches.get(body.ref);
      if (!from) return json(res, 400, { message: "Invalid reference name" });
      pr.branches.set(body.branch, { head: from.head, protected: false });
      return json(res, 201, { name: body.branch });
    }
    if ((r = rest.match(/^\/repository\/branches\/(.+)$/))) {
      const name = decodeURIComponent(r[1]);
      const b = pr.branches.get(name);
      if (!b) return json(res, 404, { message: "404 Branch Not Found" });
      if (m === "DELETE") {
        pr.branches.delete(name);
        return json(res, 204, undefined);
      }
      return json(res, 200, { name, protected: b.protected, commit: { id: b.head } });
    }
    if ((r = rest.match(/^\/repository\/files\/(.+)\/raw$/))) {
      const file = decodeURIComponent(r[1]);
      const ref = url.searchParams.get("ref") ?? "";
      const text = pr.branches.has(ref) ? headFiles(pr, ref)[file] : undefined;
      if (text === undefined) return json(res, 404, { message: "404 File Not Found" });
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(text);
    }
    if (rest === "/repository/commits" && m === "POST") {
      const files = { ...headFiles(pr, body.branch) };
      for (const a of body.actions) files[a.file_path] = a.content;
      return json(res, 201, { id: commit(pr, body.branch, body.commit_message, files) });
    }
    if (rest === "/repository/commits" && m === "GET") return paged(logOf(pr, url.searchParams.get("ref_name") ?? "").map((c) => ({ id: c.id, title: c.message.split("\n")[0], message: c.message })));
    if ((r = rest.match(/^\/repository\/commits\/([0-9a-f]+)\/revert$/)) && m === "POST") {
      const c = pr.commits.get(r[1]);
      if (!c) return json(res, 404, { message: "404 Commit Not Found" });
      if ((pr as any).failReverts) return json(res, 400, { message: "Sorry, we cannot revert this commit automatically." });
      // The inverse of what the commit changed against its first parent, on top of the branch as it is now.
      const before = pr.commits.get(c.parent_ids[0])!.files;
      const files = { ...headFiles(pr, body.branch) };
      for (const k of new Set([...Object.keys(before), ...Object.keys(c.files)])) if (before[k] !== c.files[k]) before[k] === undefined ? delete files[k] : (files[k] = before[k]);
      return json(res, 201, { id: commit(pr, body.branch, `Revert "${c.message.split("\n")[0]}"\n\nThis reverts commit ${c.id}`, files) });
    }
    if ((r = rest.match(/^\/repository\/commits\/([0-9a-f]+)\/cherry_pick$/)) && m === "POST") {
      const c = pr.commits.get(r[1])!;
      const before = pr.commits.get(c.parent_ids[0])!.files;
      const files = { ...headFiles(pr, body.branch) };
      for (const k of Object.keys(c.files)) if (c.files[k] !== before[k]) files[k] = c.files[k];
      return json(res, 201, { id: commit(pr, body.branch, `${c.message}\n\n(cherry picked from commit ${c.id})`, files) });
    }
    if (rest === "/repository/compare") {
      const from = url.searchParams.get("from") ?? "";
      const a = pr.tags.has(from) ? pr.commits.get(pr.tags.get(from)!)!.files : headFiles(pr, from);
      const b = headFiles(pr, url.searchParams.get("to") ?? "");
      const diffs = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).map((f) => ({ new_path: f }));
      return json(res, 200, { diffs });
    }
    if (rest === "/merge_requests" && m === "GET") {
      let list = pr.mrs;
      const st = url.searchParams.get("state");
      if (st) list = list.filter((x) => x.state === st);
      const tb = url.searchParams.get("target_branch");
      if (tb) list = list.filter((x) => x.target_branch === tb);
      return paged(list);
    }
    if (rest === "/merge_requests" && m === "POST") {
      const mr = { iid: pr.nextIid++, id: ++nid, title: body.title, source_branch: body.source_branch, target_branch: body.target_branch, state: "opened", web_url: `${pr.path}/-/merge_requests/${pr.nextIid - 1}`, author: ME, squash: body.squash };
      pr.mrs.push(mr);
      return json(res, 201, mr);
    }
    if ((r = rest.match(/^\/merge_requests\/(\d+)(\/.*)?$/))) {
      const mr = pr.mrs.find((x) => x.iid === Number(r![1]));
      if (!mr) return json(res, 404, { message: "404 Not found" });
      const sub = r[2] ?? "";
      if (sub === "" && m === "GET") {
        if (mr.state === "opened" && pr.mergeChecks > 0) {
          pr.mergeChecks--;
          return json(res, 200, { ...mr, detailed_merge_status: "checking" });
        }
        return json(res, 200, { ...mr, detailed_merge_status: mr.state === "opened" ? "mergeable" : undefined });
      }
      if (sub === "" && m === "PUT") {
        if (body.state_event === "close") mr.state = "closed";
        return json(res, 200, mr);
      }
      if (sub === "" && m === "DELETE") {
        pr.mrs = pr.mrs.filter((x) => x !== mr);
        return json(res, 204, undefined);
      }
      if (sub === "/merge" && m === "PUT") {
        if ((pr as any).refuseMerge) return json(res, 405, { message: "Method Not Allowed" });
        // Like GitLab's default "merge commit" method: an optional squash commit on the source branch, then a merge commit
        // on the target with two parents (target head first). With ffOnly the squash commit is put on the target itself.
        const files = { ...headFiles(pr, mr.source_branch) };
        let squash: string | undefined;
        if (mr.squash) squash = commit(pr, mr.source_branch, body.squash_commit_message ?? mr.title, files);
        const tip = squash ?? pr.branches.get(mr.source_branch)!.head;
        const merge = commit(pr, mr.target_branch, `Merge branch '${mr.source_branch}' into '${mr.target_branch}'`, files, tip);
        mr.state = "merged";
        mr.merged_at = new Date().toISOString();
        mr.squash_commit_sha = squash ?? null;
        mr.merge_commit_sha = merge;
        if (body.should_remove_source_branch) pr.branches.delete(mr.source_branch);
        return json(res, 200, { ...mr, sha: merge });
      }
      if (sub.startsWith("/notes")) {
        const list = pr.notes.get(mr.iid) ?? [];
        const nn = sub.match(/^\/notes\/(\d+)$/);
        if (nn && m === "DELETE") {
          pr.notes.set(mr.iid, list.filter((x) => x.id !== Number(nn[1])));
          return json(res, 204, undefined);
        }
        return paged(list);
      }
    }
    json(res, 404, { message: `fake gitlab: no route ${m} ${p}` });
  });
  const url = await listen(server);

  return {
    url,
    projects,
    requests,
    ME,
    OTHER,
    writes: () => requests.filter((r) => r.method !== "GET"),
    /** An empty project is made with one commit on `branch` and the tag demo-baseline, like setup-gitlab.mjs leaves it. */
    addProject(path: string, files: Record<string, string>, branch = "main", extraBranches: string[] = []) {
      const pr: FProject = { id: ++nid, path, empty: false, commits: new Map(), branches: new Map(), tags: new Map(), mrs: [], notes: new Map(), nextIid: 1, pipelines: [], mergeChecks: 0 };
      const id = sha();
      pr.commits.set(id, { id, message: "initial", parent_ids: [], files });
      pr.branches.set(branch, { head: id, protected: false });
      for (const b of extraBranches) pr.branches.set(b, { head: id, protected: false });
      pr.tags.set("demo-baseline", id);
      projects.set(path, pr);
      return pr;
    },
    addNote(path: string, iid: number, body: string, who: "me" | "other" = "me", system = false) {
      const pr = projects.get(path)!;
      const list = pr.notes.get(iid) ?? [];
      list.push({ id: ++nnote, body, author: who === "me" ? ME : OTHER, system });
      pr.notes.set(iid, list);
    },
    /** What the qa-sentinel pipeline would leave behind: a branch and an open merge request, authored by whoever. */
    addAgentMr(path: string, branch: string, title: string) {
      const pr = projects.get(path)!;
      pr.branches.set(branch, { head: pr.branches.get("main")!.head, protected: false });
      const mr = { iid: pr.nextIid++, id: ++nid, title, source_branch: branch, target_branch: "main", state: "opened", web_url: "x", author: ME };
      pr.mrs.push(mr);
      return mr;
    },
    files: (path: string, branch: string) => headFiles(projects.get(path)!, branch),
    /** A commit made by someone else, changing only the given files. */
    addCommit(path: string, branch: string, message: string, change: Record<string, string>) {
      const pr = projects.get(path)!;
      return commit(pr, branch, message, { ...headFiles(pr, branch), ...change });
    },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
