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

/** Who gets the event: its own list. Only `showcase-ready` falls back to showcase.notify (who to tag when a story is ready for review). */
export function recipients(c: Config, event: NotifyEvent): string[] {
  const own = c.reporting.jira.notify[event].to;
  return own.length || event !== "showcase-ready" ? own : c.showcase.notify;
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

export type NotifyOutcome = "sent" | "duplicate" | "off" | "nobody" | "failed";

/**
 * Post the notification unless the event is off, nobody is to be told, or it was already sent. The record is marked
 * BEFORE the comment is posted: if the record cannot be saved nothing is posted (a notification that cannot be
 * remembered would be repeated on every run), and if the post fails the mark is taken back so the next run tries again.
 * Notifications are new comments with the configured `reporting.jira.visibility` (like every qa-sentinel comment): a
 * restricted comment notifies only people who can see it. Never throws.
 */
export async function notifyOutcome(o: NotifyOptions): Promise<NotifyOutcome> {
  const rule = o.c.reporting.jira.notify[o.event];
  if (!rule.on || !SAFE_KEY.test(o.story)) return "off";
  const to = recipients(o.c, o.event);
  if (!to.length) {
    log.dim(`${o.story}: ${o.event}: nobody to tell (set reporting.jira.notify.${o.event}.to${o.event === "showcase-ready" ? " or showcase.notify" : ""})`);
    return "nobody";
  }
  const now = o.now ?? new Date();
  const mark = { event: o.event, key: o.key, at: now.toISOString() };
  try {
    return await o.store.locked(o.story, async () => {
      const rec = (await o.store.load(o.story)) ?? emptyRecord(o.story, now);
      if (rec.notified.some((n) => n.event === o.event && n.key === o.key)) return "duplicate";
      try {
        await o.store.save({ ...rec, notified: [...rec.notified, mark], updatedAt: mark.at });
      } catch (e) {
        log.warn(`${o.story}: notification ${o.event} not sent: the story record could not be saved (${(e as Error).message.split("\n")[0]}), and an unrecorded notification would be repeated on every run`);
        return "failed";
      }
      try {
        await writeIssueComment(o.ctx, o.story, undefined, `${to.map(mentionOf).join(" ")} ${o.text}\n\n{color:#97a0af}qa-sentinel:notify:${o.event}{color}`, o.c.reporting.jira.visibility);
      } catch (e) {
        log.warn(`${o.story}: notification ${o.event} not sent: ${(e as Error).message.split("\n")[0]}`);
        // Take the mark back so the next run tries again.
        for (let i = 0; i < 2; i++) {
          try {
            await o.store.save({ ...rec, updatedAt: mark.at });
            break;
          } catch {
            /* try once more */
          }
        }
        return "failed";
      }
      log.info(`${o.story}: told ${to.length} person(s): ${o.event}`);
      return "sent";
    });
  } catch (e) {
    log.warn(`${o.story}: notification ${o.event} not sent: ${(e as Error).message.split("\n")[0]}`);
    return "failed";
  }
}

/** True when a comment was posted. */
export async function notify(o: NotifyOptions): Promise<boolean> {
  return (await notifyOutcome(o)) === "sent";
}

/** For commands that only have the working folder: open the Jira connection and the record, then notify. Does nothing without Jira credentials. */
export async function notifyStoryOutcome(cwd: string, c: Config, story: string, event: NotifyEvent, text: string, key: string, env: NodeJS.ProcessEnv = process.env, store?: RecordStore): Promise<NotifyOutcome> {
  if (!c.reporting.jira.notify[event].on) return "off";
  const ctx = jiraContext(c.requirements.jira.baseUrl, env);
  if (!ctx) return "off";
  return notifyOutcome({ c, ctx, store: store ?? openStore(cwd, c, env), story, event, text, key });
}

export async function notifyStory(cwd: string, c: Config, story: string, event: NotifyEvent, text: string, key: string, env: NodeJS.ProcessEnv = process.env, store?: RecordStore): Promise<boolean> {
  return (await notifyStoryOutcome(cwd, c, story, event, text, key, env, store)) === "sent";
}
