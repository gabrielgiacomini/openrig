// Per-seat bot tokens: a channel-map entry's own SLACK_BOT_TOKEN makes that seat's posts come from its own
// Slack app, while inbound stays on the shared app's one Socket Mode connection. Covers loading (0600, xoxb-,
// fallback to shared), the post path (seat token, buttons stay shared, refusal falls back once, reads stay
// shared), the narrow live-mention rule, chat.update ownership, and the inbound drop of the seat apps' posts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatIdentities, loadSeatPosters, resolveSeatPoster } from "../src/domain/gateway/slack/seat-tokens.js";
import { setChannelMapEntry, validateChannelMap } from "../src/domain/gateway/slack/channel-map.js";
import { SEAT_TYPED_REPLY_HINT, SEAT_TYPED_REPLY_HINT_MANY, TYPED_REPLY_HINT, buildOutboundMessage } from "../src/domain/gateway/slack/message.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { DEFAULT_CONFIG, saveConfig, staticReadiness } from "../src/domain/gateway/slack/config.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { InboundRouter, handleEnvelope, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { InboundReceiptStore } from "../src/domain/gateway/slack/state-store.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import type { SecretFsOps } from "../src/domain/gateway/slack/secrets.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";

const SHARED = "xoxb-SHARED-fake";
const SEAT = "xoxb-SEAT-fake";
const auth = (init?: RequestInit) => String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeFs(files: Record<string, { mode: number; text: string }>): SecretFsOps {
  return {
    readFileSync: (p) => { const f = files[p]; if (!f) throw new Error("ENOENT"); return f.text; },
    statMode: (p) => files[p]?.mode ?? null,
  };
}

describe("loading seat tokens", () => {
  const entry = (over: Record<string, unknown> = {}) => ({ match: "lead@my-rig", channel: "C0SEAT", outboundSecretsEnvFile: "/s/lead.env", ...over });

  it("loads SLACK_BOT_TOKEN from a 0600 file, and only from the file", () => {
    const env = { SLACK_BOT_TOKEN: "xoxb-FROM-ENV-fake" };
    const before = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
    try {
      const r = loadSeatPosters({ channelMap: [entry({ appId: "A0SEAT" })] }, { fsops: fakeFs({ "/s/lead.env": { mode: 0o600, text: `SLACK_BOT_TOKEN=${SEAT}\n` } }), sharedToken: SHARED });
      expect(r.problems).toEqual([]);
      expect(r.posters).toEqual([{ match: "lead@my-rig", token: SEAT, envFile: "/s/lead.env", appId: "A0SEAT", allowHumanMentions: false }]);
    } finally {
      if (before === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = before;
    }
  });

  it.each([
    ["missing", {}, "is missing"],
    ["group-readable", { "/s/lead.env": { mode: 0o640, text: `SLACK_BOT_TOKEN=${SEAT}` } }, "should be 0600"],
    ["keyless", { "/s/lead.env": { mode: 0o600, text: "OTHER=1" } }, "has no SLACK_BOT_TOKEN"],
    ["not a bot token", { "/s/lead.env": { mode: 0o600, text: "SLACK_BOT_TOKEN=xapp-1-fake" } }, "not a bot token"],
  ])("falls back to the shared token when the file is %s, and never names the value", (_name, files, why) => {
    const r = loadSeatPosters({ channelMap: [entry()] }, { fsops: fakeFs(files as Record<string, { mode: number; text: string }>) });
    expect(r.posters).toEqual([]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(why);
    expect(r.problems[0]).toContain("shared token");
    expect(r.problems.join(" ")).not.toContain(SEAT);
    expect(r.problems.join(" ")).not.toContain("xapp-1-fake");
  });

  it("warns, without values, when the file holds more than the bot token or repeats the shared one", () => {
    const r = loadSeatPosters({ channelMap: [entry()] }, { fsops: fakeFs({ "/s/lead.env": { mode: 0o600, text: `SLACK_BOT_TOKEN=${SHARED}\nSLACK_APP_TOKEN=xapp-1-fake\n` } }), sharedToken: SHARED });
    expect(r.posters).toHaveLength(1);
    expect(r.problems.join("\n")).toContain("holds the shared bot token");
    expect(r.problems.join("\n")).toContain("also sets SLACK_APP_TOKEN");
    expect(r.problems.join(" ")).not.toContain(SHARED);
    expect(r.problems.join(" ")).not.toContain("xapp-1-fake");
  });

  it("resolves a seat entry first, then its rig entry, else the shared app", () => {
    const posters = [
      { match: "my-rig", token: "xoxb-RIG-fake", envFile: "/r", allowHumanMentions: false },
      { match: "lead@my-rig", token: SEAT, envFile: "/s", allowHumanMentions: false },
    ];
    expect(resolveSeatPoster(posters, "lead@my-rig")?.token).toBe(SEAT);
    expect(resolveSeatPoster(posters, "worker@my-rig")?.token).toBe("xoxb-RIG-fake");
    expect(resolveSeatPoster(posters, "other@else")).toBeUndefined();
    expect(resolveSeatPoster(posters, null)).toBeUndefined();
  });
});

describe("channel-map schema", () => {
  it("accepts the seat-bot fields and refuses bad ones with a teaching error", () => {
    expect(() => validateChannelMap({ channel: "C0", channelMap: [{ match: "lead@my-rig", channel: "C1", outboundSecretsEnvFile: "/abs/x.env", appId: "A0SEAT", allowHumanMentions: true }] })).not.toThrow();
    expect(() => validateChannelMap({ channel: "C0", channelMap: [{ match: "lead@my-rig", channel: "C1", outboundSecretsEnvFile: "relative.env" }] })).toThrow(/absolute path/);
    expect(() => validateChannelMap({ channel: "C0", channelMap: [{ match: "lead@my-rig", channel: "C1", outboundSecretsEnvFile: "/a", appId: "B0BOT" }] })).toThrow(/app ID/);
    expect(() => validateChannelMap({ channel: "C0", channelMap: [{ match: "lead@my-rig", channel: "C1", allowHumanMentions: true }] })).toThrow(/needs outboundSecretsEnvFile/);
  });

  it("keeps a seat's bot settings when its channel is set again from the CLI", () => {
    const map = [{ match: "lead@my-rig", channel: "C1", outboundSecretsEnvFile: "/a.env", appId: "A0SEAT", allowHumanMentions: true }];
    expect(setChannelMapEntry(map, { match: "lead@my-rig", channel: "C2" })).toEqual([{ match: "lead@my-rig", channel: "C2", outboundSecretsEnvFile: "/a.env", appId: "A0SEAT", allowHumanMentions: true }]);
  });
});

describe("live mentions: registered people only, nothing else", () => {
  const render = (body: string, allowed?: ReadonlySet<string>) => buildOutboundMessage({ qitemId: "q1", summary: "<@UPERSON> in a subject", body }, { sourceLabel: "x", allowedMentionUserIds: allowed });
  const allowed = new Set(["UPERSON"]);

  it("keeps an allowed person's <@U…> live in mrkdwn and rich text, and the fallback text", () => {
    const m = render("Done, <@UPERSON>.\n\n- for <@UPERSON> **and <@UPERSON>**", allowed);
    expect(m.text).toContain("Done, <@UPERSON>.");
    const blocks = JSON.stringify(m.blocks);
    expect(blocks).toContain("Done, <@UPERSON>.");
    expect(blocks).toContain('{"type":"user","user_id":"UPERSON"}');
  });

  it("escapes everything else: other users, labelled forms, broadcasts, code, and the subject", () => {
    const m = render("<@UOTHER> <@UPERSON|Gabe> <!channel> <!here> <!everyone> <!subteam^S1> `<@UPERSON>`", allowed);
    const section = (m.blocks as Array<{ type: string; text?: { text: string } }>).filter((b) => b.type === "section").map((b) => b.text!.text).join("\n");
    expect(section).toContain("&lt;@UOTHER&gt;");
    expect(section).toContain("&lt;@UPERSON|Gabe&gt;");
    for (const broadcast of ["channel", "here", "everyone", "subteam^S1"]) expect(section).toContain(`&lt;!${broadcast}&gt;`);
    expect(section).toContain("`&lt;@UPERSON&gt;`");
    expect(section).toContain("*&lt;@UPERSON&gt; in a subject*");
    expect(m.text).not.toMatch(/<[@!]/);
  });

  it("is today's fully inert body without an allow-list", () => {
    expect(JSON.stringify(render("Done, <@UPERSON>.").blocks)).not.toContain("<@UPERSON>");
  });
});

describe("posting as the seat", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "slack-seat-tokens-")); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
  const stores = () => ({ delivered: new SeenStore(join(home, "delivered")), attempted: new SeenStore(join(home, "attempted")), outboundSeen: new SeenStore(join(home, "seen")) });
  const decision = (payload: Record<string, unknown>, id = "d1"): OutboundDecision => ({ kind: "outbound_decision", decisionId: id, op: "post_message", entityBindingRef: "human@external", payload: { qitemId: `q-${id}`, sourceSession: "lead@my-rig", destinationSession: "human@external", summary: "Status", body: "Done.", ...payload } });
  const seatPoster = () => ({ token: SEAT, label: "lead@my-rig" });

  it("posts with the seat token and reads (reconcile) with the shared one", async () => {
    const calls: Array<{ method: string; auth: string }> = [];
    let posts = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = new URL(url).pathname.split("/").pop()!;
      calls.push({ method, auth: auth(init) });
      if (method === "chat.postMessage") return ++posts === 1 ? Promise.reject(new Error("timeout")) : reply({ ok: true, ts: "1.1" });
      return reply({ ok: true, messages: [] });
    });
    const opts = { ...stores(), botToken: SHARED, channel: "C0", sourceLabel: "x", fetchImpl, resolvePoster: seatPoster };
    expect((await subsystemSlackDeliver(opts)(decision({}))).ok).toBe(false);
    expect(await subsystemSlackDeliver({ ...opts, ...stores() })(decision({}))).toEqual({ ok: true });
    expect(calls.filter((c) => c.method === "chat.postMessage").map((c) => c.auth)).toEqual([`Bearer ${SEAT}`, `Bearer ${SEAT}`]);
    expect(calls.filter((c) => c.method === "conversations.history").map((c) => c.auth)).toEqual([`Bearer ${SHARED}`]);
  });

  it("retries once with the shared token when Slack definitely refused the seat token", async () => {
    const posted: string[] = [];
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      posted.push(auth(init));
      return posted.length === 1 ? reply({ ok: false, error: "not_in_channel" }) : reply({ ok: true, ts: "2.1" });
    });
    const out = await subsystemSlackDeliver({ ...stores(), botToken: SHARED, channel: "C0", sourceLabel: "x", fetchImpl, resolvePoster: seatPoster, log: (m) => logs.push(m) })(decision({}));
    expect(out).toEqual({ ok: true });
    expect(posted).toEqual([`Bearer ${SEAT}`, `Bearer ${SHARED}`]);
    expect(logs.some((l) => l.includes("lead@my-rig refused (not_in_channel)"))).toBe(true);
    expect(logs.join("\n")).not.toContain(SEAT);
  });

  it("does not fall back on an ambiguous failure (it may have posted)", async () => {
    const posted: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => { posted.push(auth(init)); return reply({ ok: false, error: "internal_error" }, 500); });
    expect((await subsystemSlackDeliver({ ...stores(), botToken: SHARED, channel: "C0", sourceLabel: "x", fetchImpl, resolvePoster: seatPoster })(decision({}))).ok).toBe(false);
    expect(posted).toEqual([`Bearer ${SEAT}`]);
  });

  it("posts every part of a split ask as the seat, decided once from the whole payload, with no buttons in any part", async () => {
    const posted: Array<{ auth: string; body: Record<string, unknown> }> = [];
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => { posted.push({ auth: auth(init), body: JSON.parse(String(init?.body)) }); return reply({ ok: true, ts: `3.${++n}` }); });
    const resolvePoster = vi.fn(() => seatPoster());
    const ask = decision({ humanDetail: "More detail.", humanQuestions: [{ id: "q", question: "Which?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }] });
    expect(await subsystemSlackDeliver({ ...stores(), botToken: SHARED, channel: "C0", sourceLabel: "x", fetchImpl, resolvePoster })(ask)).toEqual({ ok: true });
    expect(posted.map((p) => p.auth)).toEqual([`Bearer ${SEAT}`, `Bearer ${SEAT}`]);
    expect(JSON.stringify(posted.map((p) => p.body.blocks))).not.toContain('"type":"actions"');
    expect(String(posted[0]!.body.text)).toContain("A. Alpha\nB. Beta");
    expect(String(posted[0]!.body.text)).toContain(SEAT_TYPED_REPLY_HINT);
  });

  it("keeps the shared app and its buttons for a split ask whose seat has no token of its own", async () => {
    const posted: string[] = [];
    const bodies: string[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => { posted.push(auth(init)); bodies.push(String(init?.body)); return reply({ ok: true, ts: `4.${++n}` }); });
    const ask = decision({ humanDetail: "More detail.", humanQuestions: [{ id: "q", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] });
    expect(await subsystemSlackDeliver({ ...stores(), botToken: SHARED, channel: "C0", sourceLabel: "x", fetchImpl, resolvePoster: () => undefined })(ask)).toEqual({ ok: true });
    expect(posted).toEqual([`Bearer ${SHARED}`, `Bearer ${SHARED}`]);
    expect(bodies[0]).toContain('"type":"actions"');
  });

  it("keeps a seat ask's typed-only render when a definite refusal falls back to the shared app", async () => {
    const posted: Array<{ auth: string; body: string }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      posted.push({ auth: auth(init), body: String(init?.body) });
      return posted.length === 1 ? reply({ ok: false, error: "not_in_channel" }) : reply({ ok: true, ts: "5.1" });
    });
    const ask = decision({ humanQuestions: [{ id: "q", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] });
    expect(await subsystemSlackDeliver({ ...stores(), botToken: SHARED, channel: "C0", sourceLabel: "x", fetchImpl, resolvePoster: seatPoster, log: () => {} })(ask)).toEqual({ ok: true });
    expect(posted.map((p) => p.auth)).toEqual([`Bearer ${SEAT}`, `Bearer ${SHARED}`]);
    expect(posted[1]!.body).toBe(posted[0]!.body);
    expect(posted[1]!.body).not.toContain('"type":"actions"');
  });

  function wire(opts: { allowHumanMentions?: boolean } = {}) {
    const registry = { ok: true as const, entities: [{ entityId: "human", class: "human" as const, displayName: "Person", address: "human@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UPERSON" }], prefs: { deliveryClass: "A" as const } }] };
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const shared = join(home, "shared.env"); writeFileSync(shared, `SLACK_BOT_TOKEN=${SHARED}\n`); chmodSync(shared, 0o600);
    const seat = join(home, "seat.env"); writeFileSync(seat, `SLACK_BOT_TOKEN=${SEAT}\n`); chmodSync(seat, 0o600);
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C0", secretsEnvFile: shared,
      channelMap: [{ match: "lead@my-rig", channel: "C0SEAT", outboundSecretsEnvFile: seat, appId: "A0SEAT", ...(opts.allowHumanMentions ? { allowHumanMentions: true } : {}) }] }, home);
    const posts: Array<{ auth: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("chat.postMessage")) { posts.push({ auth: auth(init), body: JSON.parse(String(init?.body)) }); return reply({ ok: true, ts: `9.${posts.length}` }); }
      return reply({ ok: true, messages: [] });
    });
    const logs: string[] = [];
    const w = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl, log: (m) => logs.push(m) });
    return { w, repo, db, posts, logs, registry, cfg: { seat, shared } };
  }

  it("wires the channel-map token into the gateway: seat posts as its app, mentions only the registered person", async () => {
    const h = wire({ allowHumanMentions: true });
    try {
      await h.repo.create({ sourceSession: "lead@my-rig", destinationSession: "human@external", humanAlert: true, summary: "Shipped", body: "Done <@UPERSON>, not <@UOTHER> or <!channel>.", nudge: false });
      const [alert] = await makeQueuePorts(h.repo, { loadHumanRegistry: () => h.registry }).listHumanAlerts({});
      h.w.dispatcher.dispatch("post_message", "human@external", alert);
      await vi.waitFor(() => expect(h.posts).toHaveLength(1));
      expect(h.posts[0]!.auth).toBe(`Bearer ${SEAT}`);
      expect(h.posts[0]!.body.channel).toBe("C0SEAT");
      expect(String(h.posts[0]!.body.text)).toContain("Done <@UPERSON>, not &lt;@UOTHER&gt; or &lt;!channel&gt;.");
      expect(h.logs.join("\n")).toContain("1 seat(s) post with their own bot token (lead@my-rig)");
      expect(h.logs.join("\n")).not.toContain(SEAT);
      expect(staticReadiness({ ...DEFAULT_CONFIG, channelMap: [{ match: "lead@my-rig", channel: "C0SEAT", outboundSecretsEnvFile: h.cfg.seat }] }, true, true).find((r) => r.label === "seat-bots"))
        .toMatchObject({ ok: true, detail: expect.stringContaining("1 of 1 seat bot token(s) loaded") });
    } finally { h.w.stop(); h.db.close(); }
  });

  it("posts an ask as the seat, without buttons: lettered options and a typed-reply hint", async () => {
    const h = wire();
    try {
      await h.repo.create({ sourceSession: "lead@my-rig", destinationSession: "human@external", humanAlert: true, humanIntent: "decision", summary: "Which plan?", body: "Pick one.", nudge: false,
        humanQuestions: [{ id: "plan", question: "Which plan?", options: [{ id: "a", label: "Fast", recommended: true }, { id: "b", label: "Safe" }] }] });
      const [alert] = await makeQueuePorts(h.repo, { loadHumanRegistry: () => h.registry }).listHumanAlerts({});
      h.w.dispatcher.dispatch("post_message", "human@external", alert);
      await vi.waitFor(() => expect(h.posts).toHaveLength(1));
      expect(h.posts[0]!.auth).toBe(`Bearer ${SEAT}`);
      expect(h.posts[0]!.body.channel).toBe("C0SEAT");
      const blocks = JSON.stringify(h.posts[0]!.body.blocks);
      expect(blocks).not.toContain('"type":"actions"');
      expect(blocks).not.toContain("or-opt:");
      expect(String(h.posts[0]!.body.text)).toContain("A. Fast (recommended)\nB. Safe");
      expect(String(h.posts[0]!.body.text)).toContain(SEAT_TYPED_REPLY_HINT);
      expect(String(h.posts[0]!.body.text)).not.toContain(TYPED_REPLY_HINT);
    } finally { h.w.stop(); h.db.close(); }
  });
});

describe("render: typed-only questions for a seat's own app", () => {
  const qs = [
    { id: "db", question: "Which database?", options: [{ id: "pg", label: "Postgres", recommended: true }, { id: "sqlite", label: "SQLite" }] },
    { id: "ship", question: "Ship this week?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }, { id: "later", label: "Later" }] },
  ];
  const render = (over: Record<string, unknown>, typedAnswersOnly?: boolean) =>
    buildOutboundMessage({ qitemId: "q1", summary: "Two questions", body: "Brief.", humanQuestions: qs, ...over }, { sourceLabel: "x", ...(typedAnswersOnly === undefined ? {} : { typedAnswersOnly }) });

  it("numbers several questions, letters options, and asks for one reply answering all", () => {
    const m = render({}, true);
    expect(JSON.stringify(m.blocks)).not.toContain('"type":"actions"');
    expect(m.text).toContain("*1. Which database?*\nA. Postgres (recommended)\nB. SQLite");
    expect(m.text).toContain("*2. Ship this week?*\nA. Yes\nB. No\nC. Later");
    expect(m.text).toContain(SEAT_TYPED_REPLY_HINT_MANY);
    expect((m.blocks as Array<{ type: string; elements?: Array<{ text?: string }> }>).at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: SEAT_TYPED_REPLY_HINT_MANY }] });
  });

  it("is byte-identical to today's render without the flag (buttons) and in a shared channel or a resolved notice", () => {
    expect(render({}, false)).toEqual(render({}));
    expect(JSON.stringify(render({}).blocks)).toContain('"type":"actions"');
    expect(render({ sharedChannel: true }, true)).toEqual(render({ sharedChannel: true }));
    expect(render({ ownerNotificationKind: "human-decision-resolved" }, true)).toEqual(render({ ownerNotificationKind: "human-decision-resolved" }));
  });

  it("keeps question and option text inert", () => {
    const m = buildOutboundMessage({ qitemId: "q1", summary: "S", body: "", humanQuestions: [{ id: "x", question: "Ping <!here>?", options: [{ id: "a", label: "<@UPERSON>" }, { id: "b", label: "no" }] }] }, { sourceLabel: "x", typedAnswersOnly: true, allowedMentionUserIds: new Set(["UPERSON"]) });
    expect(m.text).toContain("Ping &lt;!here&gt;?");
    expect(m.text).toContain("A. &lt;@UPERSON&gt;");
  });
});

describe("the seat apps' own posts never come back in", () => {
  function memFs(): StateFsOps {
    const files = new Map<string, string>();
    return {
      readFileSync: (p) => { if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(p)!; },
      appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
      writeFileSync: (p, d) => files.set(p, d),
      rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
      mkdirp: () => {},
    };
  }
  function harness(withInbox: boolean) {
    const fsops = memFs();
    const clock = () => new Date("2026-11-10T04:00:00Z");
    const rows: unknown[] = [];
    const ids = new SeatIdentities([{ match: "lead@my-rig", token: SEAT, envFile: "/s", appId: "A0SEAT", allowHumanMentions: false }]);
    const router = new InboundRouter({
      queue: { createQitem: async (input: { qitemId: string }) => { rows.push(input); return input.qitemId; } },
      seen: new SeenStore("/s.jsonl", fsops, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/d.jsonl", fsops, clock),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human@external" }),
      resolveRoute: makeThreadRouteResolver({ map: { resolveByThread: () => null, resolveByConversation: () => null, partOf: () => null } as never, unroutedDestination: "operator-agent@kernel" }),
      ...(withInbox ? { botInbox: { channel: "C0SEAT", destination: "lead@my-rig", bots: [{ appId: "A0SEAT", name: "Seat app named by mistake" }], lookupBot: async () => ({ ok: true as const, appId: "A0SEAT" }) } } : {}),
      seatIdentities: ids,
      log: () => {},
    } as never);
    const deliver = (event: SlackEvent) => handleEnvelope({ envelope_id: "e", type: "events_api", payload: { event, api_app_id: "A0SHARED" } }, () => {}, router);
    return { router, rows, ids, deliver };
  }

  it("drops a seat app's post by its bot user even with no bot_id, once auth.test has named it", async () => {
    const h = harness(false);
    h.ids.learn({ userId: "U0SEATBOT", botId: "B0SEAT" });
    expect(await h.deliver({ type: "message", user: "U0SEATBOT", text: "echo", ts: "1.1", channel: "C0SEAT" })).toEqual({ status: "ignored", reason: "own-seat-app" });
    expect(await h.deliver({ type: "message", bot_id: "B0SEAT", text: "echo", ts: "1.2", channel: "C0SEAT" })).toEqual({ status: "ignored", reason: "own-seat-app" });
    expect(await h.deliver({ type: "message", user: "UHUMAN", app_id: "A0SEAT", text: "x", ts: "1.3", channel: "C0SEAT" })).toEqual({ status: "ignored", reason: "own-seat-app" });
    expect(h.rows).toEqual([]);
    // Control: a person's message in the same channel still lands.
    expect((await h.deliver({ type: "message", user: "UHUMAN", text: "hello", ts: "1.4", channel: "C0SEAT" })).status).toBe("accepted");
  });

  it("drops any bot post on the person path, as 0.7.9 already does", async () => {
    const h = harness(false);
    expect(await h.deliver({ type: "message", bot_id: "B0UNKNOWN", text: "x", ts: "2.1", channel: "C0SEAT" })).toEqual({ status: "ignored", reason: "bot_id" });
  });

  it("never admits a seat app through botInbox, even if the config names it", async () => {
    const h = harness(true);
    expect(await h.deliver({ type: "message", bot_id: "B0NOTLEARNT", text: "echo", ts: "3.1", channel: "C0SEAT" })).toEqual({ status: "ignored", reason: "own-app" });
    expect(h.rows).toEqual([]);
  });
});

describe("chat.update ownership: only the posting bot can edit its message", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "slack-seat-update-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });
  const registry = { ok: true as const, entities: [{ entityId: "person", class: "human" as const, displayName: "Person", address: "person@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UPERSON" }], prefs: { deliveryClass: "A" as const } }] };

  it.each([
    ["a seat-posted ask is edited with the seat token", false, [`Bearer ${SEAT}`]],
    ["a seat ask that fell back to the shared app (not_in_channel) is edited through cant_update_message with the shared token", true, [`Bearer ${SEAT}`, `Bearer ${SHARED}`]],
  ] as const)("%s", async (_name, refused, expected) => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const shared = join(home, "shared.env"); writeFileSync(shared, `SLACK_BOT_TOKEN=${SHARED}\n`); chmodSync(shared, 0o600);
    const seat = join(home, "seat.env"); writeFileSync(seat, `SLACK_BOT_TOKEN=${SEAT}\n`); chmodSync(seat, 0o600);
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-ASKS", secretsEnvFile: shared, channelMap: [{ match: "author@rig", channel: "C-ASKS", outboundSecretsEnvFile: seat }] }, home);
    const messages: Array<Record<string, unknown> & { poster: string }> = [];
    const updates: string[] = [];
    const updateBodies: Array<Record<string, unknown>> = [];
    const w = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, log: () => {},
      fetchImpl: async (url, init) => {
        const api = new URL(url); const method = api.pathname.split("/").at(-1)!;
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        const params = { ...Object.fromEntries(api.searchParams), ...body };
        if (method === "chat.postMessage" && refused && auth(init) === `Bearer ${SEAT}` && messages.length === 0) return reply({ ok: false, error: "not_in_channel" });
        if (method === "chat.postMessage") { const m = { ...body, ts: `${messages.length + 1}.000001`, poster: auth(init) }; messages.push(m); return reply({ ok: true, ts: m.ts }); }
        if (method === "chat.update") {
          updates.push(auth(init)); updateBodies.push(body);
          const m = messages.find((x) => x.ts === body.ts)!;
          if (m.poster !== auth(init)) return reply({ ok: false, error: "cant_update_message" });
          return reply({ ok: true, ts: body.ts, channel: body.channel });
        }
        if (method === "conversations.history" || method === "conversations.replies") {
          const ts = params.latest ?? params.oldest ?? params.ts;
          return reply({ ok: true, messages: messages.filter((m) => m.channel === params.channel && (!ts || m.ts === ts)).map(({ poster: _p, ...m }) => m) });
        }
        return reply({ ok: true, messages: [] });
      } });
    w.startServices?.();
    try {
      const item = await repo.create({ sourceSession: "author@rig", destinationSession: "person@external", summary: "Ship it?", body: "Brief.", nudge: false,
        humanQuestions: [{ id: "ship", question: "Ship now?", options: [{ id: "yes", label: "Ship" }, { id: "hold", label: "Hold" }] }] });
      const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
      w.dispatcher.dispatch("post_message", "person@external", alert);
      await vi.waitFor(() => expect(repo.currentHumanRequiredEpisode(item.qitemId)?.receipt?.messageTs).toBe("1.000001"));
      expect(messages[0]!.poster).toBe(refused ? `Bearer ${SHARED}` : `Bearer ${SEAT}`);
      repo.update({ qitemId: item.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on", transitionNote: "Handled." });
      await vi.waitFor(() => expect(repo.listTransitions(item.qitemId).some((t) => t.transitionNote?.startsWith("slack-ask-settled "))).toBe(true));
      expect(updates).toEqual(expected);
      // Settling removes the typed-reply hint, as it removes buttons and the other reply hints.
      const edited = updateBodies.at(-1)!;
      expect(String(edited.text)).not.toContain(SEAT_TYPED_REPLY_HINT);
      expect((edited.blocks as Array<{ elements?: Array<{ text?: string }> }>).some((b) => b.elements?.[0]?.text === SEAT_TYPED_REPLY_HINT)).toBe(false);
      expect(String(edited.text)).toContain("Ship now?");
    } finally { w.stop(); db.close(); }
  });
});

// End to end through the real wire and the real resolver: a seat-posted ask (no buttons) is answered by a person's
// typed thread reply, which the SHARED app's socket hears and routes by (channel, thread_ts), whoever posted the root.
describe("a seat-posted ask is answered by a typed thread reply heard on the shared socket", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let bus: EventBus;
  let repo: QueueRepository;
  const stops: Array<() => void> = [];
  const human = "person@external";
  const registry = { ok: true as const, entities: [{ entityId: "person", class: "human" as const, displayName: "Person", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UPERSON" }], prefs: { deliveryClass: "A" as const } }] };
  const questions = [
    { id: "db", question: "Which database?", options: [{ id: "pg", label: "Postgres", recommended: true }, { id: "sqlite", label: "SQLite" }] },
    { id: "ship", question: "Ship this week?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  ];
  let posts: Array<Record<string, unknown> & { poster: string }>;
  let socket: WsLike;
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  let logs: string[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "slack-seat-typed-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    const shared = join(home, "shared.env"); writeFileSync(shared, `SLACK_BOT_TOKEN=${SHARED}\nSLACK_APP_TOKEN=xapp-SHARED-fake\n`); chmodSync(shared, 0o600);
    const seat = join(home, "seat.env"); writeFileSync(seat, `SLACK_BOT_TOKEN=${SEAT}\n`); chmodSync(seat, 0o600);
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-DEFAULT", secretsEnvFile: shared, minimumLevelThatInterrupts: "NOTICE",
      channelMap: [{ match: "author@rig", channel: "C-SEAT", inbound: "author@rig", outboundSecretsEnvFile: seat, appId: "A0SEAT", allowHumanMentions: true }] }, home);
    posts = []; logs = [];
    const sockets: WsLike[] = [];
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      resolveHumanReply: makeHumanReplyResolver(repo, contract),
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      log: (m) => logs.push(m),
      fetchImpl: async (url, init) => {
        const method = new URL(url).pathname.split("/").at(-1)!;
        if (method === "apps.connections.open") return reply({ ok: true, url: "wss://fake-slack/ws" });
        if (method === "auth.test") return reply(auth(init) === `Bearer ${SEAT}` ? { ok: true, user_id: "U0SEATBOT", bot_id: "B0SEAT", app_id: "A0SEAT" } : { ok: true, user_id: "U0SHARED", bot_id: "B0SHARED" });
        if (method === "chat.postMessage") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const m = { ...body, ts: `${posts.length + 1}.1`, poster: auth(init) }; posts.push(m); return reply({ ok: true, ts: m.ts });
        }
        return reply({ ok: true, messages: [] });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    socket = sockets[0]!;
    socket.onopen?.();
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

  const finals = (envelopeId: string) => new InboundReceiptStore(join(home, "state", "slack-inbound-receipts.jsonl")).readAll()
    .filter((r) => r.envelopeId === envelopeId && r.status !== "received");
  async function event(envelopeId: string, ev: Record<string, unknown>): Promise<void> {
    const before = finals(envelopeId).length;
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: envelopeId, type: "events_api", payload: { event: { type: "message", channel: "C-SEAT", ...ev }, api_app_id: "A0SHARED" } }) });
    await vi.waitFor(() => expect(finals(envelopeId).length).toBe(before + 1));
  }
  async function postAsk(humanQuestions: typeof questions): Promise<{ id: string; root: string }> {
    const item = await repo.create({ humanAlert: true, sourceSession: "author@rig", destinationSession: human, summary: "Two quick questions", body: "Pick one for each.", nudge: false, humanIntent: "decision", humanQuestions });
    const alert = async () => (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === item.qitemId);
    wire.dispatcher.dispatch("post_message", human, await alert());
    await vi.waitFor(async () => expect(await alert()).toBeUndefined());
    return { id: item.qitemId, root: String(posts.at(-1)!.ts) };
  }
  const repliesToSeat = () => repo.list({ limit: 100 }).filter((q) => q.destinationSession === "author@rig");

  it("resolves a two-question ask from one typed reply, as the existing typed path does, and drops the seat's own echo", async () => {
    const { id, root } = await postAsk(questions);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.poster).toBe(`Bearer ${SEAT}`);
    expect(posts[0]!.channel).toBe("C-SEAT");
    expect(JSON.stringify(posts[0]!.blocks)).not.toContain('"type":"actions"');
    expect(String(posts[0]!.text)).toContain(SEAT_TYPED_REPLY_HINT_MANY);
    // The seat bot's own post comes back on the shared socket as a bot message: never a person's reply.
    await event("e-echo", { bot_id: "B0SEAT", app_id: "A0SEAT", user: "U0SEATBOT", text: "echo", ts: root });
    expect(repliesToSeat()).toEqual([]);
    expect(repo.getById(id)).toMatchObject({ state: "pending" });
    // The person's typed thread reply under the seat-posted root.
    const text = "1: A, 2: B";
    await event("e-typed", { user: "UPERSON", text, ts: "3000.1", thread_ts: root });
    const item = repo.getById(id)!;
    expect(item).toMatchObject({ state: "done", humanAnswers: { db: { kind: "typed-reply", text, placement: "first-unanswered", unansweredCount: 1 } } });
    const [answer] = repliesToSeat();
    expect(answer?.sourceSession).toBe(human);
    expect(answer?.tags).toEqual(expect.arrayContaining([`reply-to:${id}`]));
    expect(answer?.body).toContain(text);
    // A Socket Mode redelivery lands nothing new.
    await event("e-typed", { user: "UPERSON", text, ts: "3000.1", thread_ts: root });
    expect(repliesToSeat()).toHaveLength(1);
    // Any acknowledgement the gateway posts stays on the shared app.
    expect(posts.slice(1).every((p) => p.poster === `Bearer ${SHARED}`)).toBe(true);
    expect(logs.join("\n")).not.toContain(SEAT);
  });

  it("resolves a single-question ask from a typed letter", async () => {
    const { id, root } = await postAsk([questions[1]!]);
    expect(String(posts[0]!.text)).toContain("A. Yes\nB. No");
    expect(String(posts[0]!.text)).toContain(SEAT_TYPED_REPLY_HINT);
    await event("e-typed-1", { user: "UPERSON", text: "B", ts: "4000.1", thread_ts: root });
    expect(repo.getById(id)).toMatchObject({ state: "done", humanAnswers: { ship: { kind: "typed-reply", text: "B", placement: "first-unanswered", unansweredCount: 0 } } });
    expect(repliesToSeat()[0]?.body).toContain("B");
  });

  it("does not take a stranger's typed reply as the answer", async () => {
    const { id, root } = await postAsk(questions);
    await event("e-stranger", { user: "USTRANGER", text: "1: B", ts: "5000.1", thread_ts: root });
    expect(repo.getById(id)).toMatchObject({ state: "pending", humanAnswers: null });
  });
});
