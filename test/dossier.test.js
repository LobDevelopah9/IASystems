process.env.IA_DB_FILE = ":memory:";
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "none";

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { seedDemo } = require("../lib/seed");
const { createApp } = require("../lib/server");
const { db } = require("../lib/db");

seedDemo();
const app = createApp();
const dossier = require("../lib/dossier");

const SUPERVISOR = "900000000000000002";
const INVESTIGATOR = "900000000000000003";
const HALE = "900000000000000005";

async function agent(id) {
	const a = request.agent(app);
	await a.get(`/auth/dev?as=${id}`).expect(302);
	return a;
}
const post = (a, path, body) => a.post(path).set("X-IA-Request", "1").send(body);
const hale = () => db.prepare("SELECT * FROM personnel WHERE discord_id = ?").get(HALE);

test("personnel files are supervisor-only", async () => {
	const p = hale();
	await (await agent(INVESTIGATOR)).get(`/api/personnel/${p.id}/file`).expect(403);
	await (await agent(HALE)).get(`/api/personnel/${p.id}/file`).expect(403);
	const res = await (await agent(SUPERVISOR)).get(`/api/personnel/${p.id}/file`).expect(200);
	assert.equal(res.body.person.name, p.name);
	assert.equal(res.body.scan.status, "never");
	assert.ok(Array.isArray(res.body.indicators));
	assert.ok(res.body.accessLog.some(a => a.action === "view"), "views are logged on the file");
});

test("file notes are append-only and audited", async () => {
	const p = hale();
	const s = await agent(SUPERVISOR);
	await post(s, `/api/personnel/${p.id}/file/notes`, { kind: "bogus", body: "hello there" }).expect(400);
	await post(s, `/api/personnel/${p.id}/file/notes`, { kind: "counseling", body: "Spoke with the member about radio discipline." }).expect(200);
	const res = await s.get(`/api/personnel/${p.id}/file`).expect(200);
	assert.equal(res.body.notes[0].kind, "counseling");
	assert.throws(() => db.prepare("UPDATE personnel_file_notes SET body = 'x'").run(), /append-only/);
	assert.throws(() => db.prepare("DELETE FROM personnel_file_notes").run(), /append-only/);
	assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'personnel.file_note'").get());
});

test("refresh queues one job at a time", async () => {
	const p = hale();
	const s = await agent(SUPERVISOR);
	await post(s, `/api/personnel/${p.id}/file/refresh`, {}).expect(200);
	await post(s, `/api/personnel/${p.id}/file/refresh`, {}).expect(200);
	const jobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'dossier' AND status = 'queued'").get().n;
	assert.equal(jobs, 1);
	const status = await s.get(`/api/personnel/${p.id}/file/status`).expect(200);
	assert.equal(status.body.status, "queued");
});

test("a pull stores the scan and keeps only verified AI flags", async () => {
	const p = hale();
	const t = Date.now();
	const bot = require("../lib/bot");
	const ai = require("../lib/ai");
	const roblox = require("../lib/roblox");
	bot.scanMember = async () => ({
		member: { id: HALE, username: "hale", displayName: "Hale", joinedAt: t - 400 * 86400000, createdAt: t - 30 * 86400000, roles: ["Trooper"] },
		discipline: [1, 2, 3].map(i => ({ id: `d${i}`, at: t - i * 86400000, channel: "discipline-log", author: "Sgt", content: `Hale strike ${i}`, url: "https://discord.com/channels/1/2/3" })),
		promotions: [{ id: "p1", at: t - 100 * 86400000, channel: "promotions", author: "Lt", content: "Hale promoted to Trooper", url: "u" }],
		commendations: [],
		leave: [],
		messages: [
			{ id: "m1", at: t, channel: "general", author: "Hale", content: "I will leak the staff chat tonight", url: "https://discord.com/channels/1/2/m1" },
			{ id: "m2", at: t, channel: "general", author: "Hale", content: "good patrol everyone", url: "u2" }
		],
		channelsScanned: 1,
		messagesScanned: 2
	});
	roblox.lookup = async () => ({ found: true, id: 1, username: "HaleRBX", createdAt: t - 20 * 86400000, banned: false, previousNames: [], groups: [] });
	ai.runJson = async ({ system, user }) => (system.includes("log posts") ? {
		// The log check confirms d1 and d2; d3 is a post the member issued to someone else.
		provider: "groq",
		model: "test",
		data: { results: String(user).includes("POST d1") ? [{ id: "d1", role: "subject" }, { id: "d2", role: "subject" }, { id: "d3", role: "issuer" }, { id: "p1", role: "subject" }] : [{ id: "p1", role: "subject" }] }
	} : {
		provider: "groq",
		model: "test",
		data: {
			summary: "Trooper Hale has three recent discipline entries.",
			strengths: ["Active on patrol"],
			concerns: ["Threatened to leak staff chat"],
			promotion_readiness: { assessment: "not_yet", rationale: "Recent discipline." },
			conduct_trend: "declining",
			flagged_messages: [
				{ id: "m1", quote: "leak the staff chat", reason: "Leaking threat", severity: "high" },
				{ id: "m2", quote: "I hate everyone", reason: "Invented quote", severity: "high" },
				{ id: "nope", quote: "anything", reason: "Unknown id", severity: "low" }
			]
		}
	});
	await dossier.run(p.id);
	const s = await agent(SUPERVISOR);
	const res = await s.get(`/api/personnel/${p.id}/file`).expect(200);
	assert.equal(res.body.scan.status, "ready");
	assert.equal(res.body.assessment.flagged.length, 1, "fabricated and unknown quotes are dropped");
	assert.equal(res.body.assessment.flagged[0].id, "m1");
	assert.equal(res.body.assessment.readiness.assessment, "not_yet");
	const texts = res.body.indicators.map(i => i.text).join(" | ");
	assert.deepEqual(res.body.scan.discipline.map(e => e.id), ["d1", "d2"], "a post the member issued is removed by the log check");
	assert.equal(res.body.scan.excluded.discipline, 1);
	assert.match(texts, /2 discipline-log entries in the last 90 days/);
	assert.match(texts, /Discord account is less than 90 days old/);
	assert.match(texts, /ROBLOX account is less than 180 days old/);
	assert.equal(res.body.service.lastPromotionAt, t - 100 * 86400000);
	assert.ok(res.body.timeline.some(e => e.kind === "promotion"));
});
