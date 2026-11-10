// Per-seat outbound bot tokens: a channel-map entry may name an `outboundSecretsEnvFile` holding ONE
// key, SLACK_BOT_TOKEN, for a Slack app that is that seat's (or rig's) own identity. Posts for that
// seat are then made with that token, so in Slack they come from the seat's own bot user rather than
// the shared app. Inbound is untouched: the shared app's Socket Mode connection still hears every
// channel, and a seat app never needs an app-level (xapp-) token.
//
// Fail-closed to the shared token: a file that is absent, group/world readable, unreadable, or holds
// no xoxb- token leaves that seat posting with the shared token, and `rig slack status` (staticReadiness)
// names why. A token VALUE is never logged, returned in a problem string, or put in argv.
import { checkEnvFilePermissions, nodeSecretFs, parseEnvFile, type SecretFsOps } from "./secrets.js";
import { sessionRigOf } from "../../session-name.js";
import type { ChannelMapEntry } from "./channel-map.js";

export const SEAT_TOKEN_KEY = "SLACK_BOT_TOKEN";

/** One seat (or rig) identity that posts with its own bot token. */
export interface SeatPoster {
  /** The channel-map `match` this token speaks for (`lead@my-rig` or `my-rig`). */
  match: string;
  /** The bot token. Never logged. */
  token: string;
  /** Where it came from, for logs and status (a path, never the value). */
  envFile: string;
  /** The seat app's ID when configured (A…); its posts are never delivered inbound. */
  appId?: string;
  /** Whether `<@U…>` naming a registered person stays a live mention in this seat's posts. */
  allowHumanMentions: boolean;
}

export interface SeatTokenLoad {
  posters: SeatPoster[];
  /** Plain-language problems, one per entry that falls back to the shared token. No values. */
  problems: string[];
}

function isSeatMatch(match: string): boolean {
  return match.includes("@");
}

/** Read every entry's `outboundSecretsEnvFile`. Only SLACK_BOT_TOKEN is read from it, and only from
 *  the file: env-var aliases are deliberately NOT consulted (they are global and would shadow every
 *  seat with one value). `sharedToken` lets a file that repeats the shared token be reported. */
export function loadSeatPosters(
  cfg: { channelMap?: ChannelMapEntry[] },
  opts: { fsops?: SecretFsOps; sharedToken?: string | null } = {},
): SeatTokenLoad {
  const fsops = opts.fsops ?? nodeSecretFs;
  const posters: SeatPoster[] = [];
  const problems: string[] = [];
  for (const [index, entry] of (cfg.channelMap ?? []).entries()) {
    const envFile = entry?.outboundSecretsEnvFile;
    if (envFile === undefined) continue;
    const where = `channelMap[${index}] ('${entry.match}')`;
    if (fsops.statMode(envFile) === null) { problems.push(`${where}: ${envFile} is missing; posts use the shared token`); continue; }
    const perms = checkEnvFilePermissions(envFile, fsops);
    if (perms) { problems.push(`${where}: ${perms}; refused, posts use the shared token`); continue; }
    let map: Record<string, string>;
    try { map = parseEnvFile(fsops.readFileSync(envFile)); }
    catch { problems.push(`${where}: ${envFile} could not be read; posts use the shared token`); continue; }
    const token = map[SEAT_TOKEN_KEY]?.trim();
    if (!token) { problems.push(`${where}: ${envFile} has no ${SEAT_TOKEN_KEY}; posts use the shared token`); continue; }
    if (!token.startsWith("xoxb-")) { problems.push(`${where}: ${SEAT_TOKEN_KEY} in ${envFile} is not a bot token (xoxb-); posts use the shared token`); continue; }
    if (opts.sharedToken && token === opts.sharedToken) problems.push(`${where}: ${envFile} holds the shared bot token, so this seat still posts as the shared app`);
    const extra = Object.keys(map).filter((k) => k !== SEAT_TOKEN_KEY);
    if (extra.length) problems.push(`${where}: ${envFile} also sets ${extra.join(", ")}; only ${SEAT_TOKEN_KEY} is read`);
    posters.push({ match: entry.match, token, envFile, ...(entry.appId ? { appId: entry.appId } : {}), allowHumanMentions: entry.allowHumanMentions === true });
  }
  return { posters, problems };
}

/** The identity a seat's posts use: its seat entry's token, else its rig entry's, else none (shared). */
export function resolveSeatPoster(posters: readonly SeatPoster[], session: string | null | undefined): SeatPoster | undefined {
  if (!session || posters.length === 0) return undefined;
  const seat = posters.find((p) => isSeatMatch(p.match) && p.match === session);
  if (seat) return seat;
  const rig = sessionRigOf(session);
  return rig ? posters.find((p) => !isSeatMatch(p.match) && p.match === rig) : undefined;
}

/** Errors after which Slack definitely did NOT post with the seat token, so one retry with the shared
 *  token cannot double-post. Anything else (timeouts, 5xx, rate limits) stays on the normal retry path. */
export const SEAT_TOKEN_FALLBACK_ERRORS: ReadonlySet<string> = new Set([
  "not_in_channel", "channel_not_found", "invalid_auth", "not_authed", "token_revoked", "token_expired",
  "account_inactive", "missing_scope", "no_permission", "ekm_access_denied", "restricted_action",
]);

/** The seat apps' identities as learnt at runtime (auth.test + bots.info) and from config. Their
 *  posts are OpenRig's own: never ingested as a person's message and never admitted by botInbox. */
export class SeatIdentities {
  readonly appIds = new Set<string>();
  readonly botIds = new Set<string>();
  readonly userIds = new Set<string>();
  constructor(posters: readonly SeatPoster[] = []) {
    for (const p of posters) if (p.appId) this.appIds.add(p.appId);
  }
  learn(found: { appId?: string; botId?: string; userId?: string }): void {
    if (found.appId) this.appIds.add(found.appId);
    if (found.botId) this.botIds.add(found.botId);
    if (found.userId) this.userIds.add(found.userId);
  }
  /** True for an event whose author is one of the seat apps, by any of the ids Slack may carry. */
  authored(ev: { bot_id?: string; user?: string; app_id?: string; bot_profile?: { app_id?: string } }): boolean {
    return Boolean(
      (ev.bot_id && this.botIds.has(ev.bot_id))
      || (ev.user && this.userIds.has(ev.user))
      || (ev.app_id && this.appIds.has(ev.app_id))
      || (ev.bot_profile?.app_id && this.appIds.has(ev.bot_profile.app_id)),
    );
  }
}
