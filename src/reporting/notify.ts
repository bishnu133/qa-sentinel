import type { Config } from "../config.js";
import { jiraContext, writeIssueComment, type JiraContext } from "../scm/jira.js";
import { emptyRecord, SAFE_KEY, type RecordStore } from "../stories/record.js";
import { openStore } from "../stories/start.js";
import { log } from "../log.js";

/**
 * Short NEW comments that mention people when something needs them. An edited comment notifies nobody, so the status
 * comment can't do this. Each notification is sent once per event and subject (`key`, for example an AC id): the
 * story record remembers it, so a schedule does not repeat it.
 */

export const NOTIFY_EVENTS = ["showcase-ready", "ac-not-built-but-ready", "cross-service-tests-ready", "stopped-by-budget", "merge-conflict"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** A Jira mention: Cloud account ids (hex, or with a colon) as [~accountid:...]; Server/Data Center usernames as [~name]. */
export const mentionOf = (user: string) => (/^[0-9a-f]{12,}$|:/.test(user) ? `[~accountid:${user}]` : `[~${user}]`);

/** Who gets the event: its own list, else showcase.notify. */
export function recipients(c: Config, event: NotifyEvent): string[] {
  const own = c.reporting.jira.notify[event].to;
  return own.length ? own : c.showcase.notify;
}

export interface NotifyOptions {
  c: Config;
  ctx: JiraContext;
  store: RecordStore;
  story: string;
  event: NotifyEvent;
  /** What to say (wiki text), without the mentions. */
  text: string;
  /** The subject, for "once per event and subject": an AC id, a branch, a job key. */
  key: string;
  now?: Date;
}

/** Post the notification unless the event is off, nobody is to be told, or it was already sent. Returns true when a comment was posted. Never throws. */
export async function notify(o: NotifyOptions): Promise<boolean> {
  const rule = o.c.reporting.jira.notify[o.event];
  if (!rule.on || !SAFE_KEY.test(o.story)) return false;
  const to = recipients(o.c, o.event);
  if (!to.length) {
    log.dim(`${o.story}: ${o.event}: nobody to tell (set reporting.jira.notify.${o.event}.to or showcase.notify)`);
    return false;
  }
  const now = o.now ?? new Date();
  try {
    return await o.store.locked(o.story, async () => {
      const rec = (await o.store.load(o.story)) ?? emptyRecord(o.story, now);
      if (rec.notified.some((n) => n.event === o.event && n.key === o.key)) return false;
      await writeIssueComment(o.ctx, o.story, undefined, `${to.map(mentionOf).join(" ")} ${o.text}\n\n{color:#97a0af}qa-sentinel:notify:${o.event}{color}`, o.c.reporting.jira.visibility);
      await o.store.save({ ...rec, notified: [...rec.notified, { event: o.event, key: o.key, at: now.toISOString() }], updatedAt: now.toISOString() });
      log.info(`${o.story}: told ${to.length} person(s): ${o.event}`);
      return true;
    });
  } catch (e) {
    log.warn(`${o.story}: notification ${o.event} not sent: ${(e as Error).message.split("\n")[0]}`);
    return false;
  }
}

/** For commands that only have the working folder: open the Jira connection and the record, then notify. Does nothing without Jira credentials. */
export async function notifyStory(cwd: string, c: Config, story: string, event: NotifyEvent, text: string, key: string, env: NodeJS.ProcessEnv = process.env, store?: RecordStore): Promise<boolean> {
  if (!c.reporting.jira.notify[event].on) return false;
  const ctx = jiraContext(c.requirements.jira.baseUrl, env);
  if (!ctx) return false;
  return notify({ c, ctx, store: store ?? openStore(cwd, c, env), story, event, text, key });
}
