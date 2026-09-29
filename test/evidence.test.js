process.env.IA_DB_FILE = ":memory:";
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "none";
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ia-evidence-"));

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { seedDemo } = require("../lib/seed");
const { createApp } = require("../lib/server");
const { db } = require("../lib/db");

seedDemo();
const app = createApp();
const evidence = require("../lib/evidence");

const INVESTIGATOR = "900000000000000003";
const HALE = "900000000000000005";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(400, 3)]);

// Fake internet: only these URLs answer. Anything else would be a bug (or an SSRF) and fails loudly.
const calls = [];
const WEB = {
	"https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1": () => new Response(PNG, { headers: { "content-type": "image/png" } }),
	"https://streamable.com/abc123": () => new Response(`<html><head><meta property="og:title" content="Trooper rams civilian"><meta property="og:video:secure_url" content="https://cdn-cf-east.streamable.com/video/abc.mp4?token=x&amp;y=1"><meta property="og:image" content="https://cdn-cf-east.streamable.com/image/abc.jpg"></head></html>`, { headers: { "content-type": "text/html" } }),
	"https://cdn-cf-east.streamable.com/video/abc.mp4?token=x&y=1": () => new Response(MP4, { headers: { "content-type": "video/mp4" } }),
	"https://cdn-cf-east.streamable.com/image/abc.jpg": () => new Response(PNG),
	"https://medal.tv/clips/gone": () => new Response("not found", { status: 404 }),
	"https://imgur.com/evil": () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
};
global.fetch = async url => {
	const key = String(url);
	calls.push(key);
	if (!WEB[key]) throw new Error(`Unexpected fetch ${key}`);
	return WEB[key]();
};

async function drain() {
	for (let i = 0; i < 20; i++) {
		const row = db.prepare("SELECT * FROM evidence_archive WHERE status = 'queued' ORDER BY id LIMIT 1").get();
		if (!row) return;
		await evidence.processOne(row);
	}
}

function haleCase() {
	return db.prepare("SELECT c.* FROM cases c JOIN personnel p ON p.id = c.subject_personnel_id WHERE p.discord_id = ? ORDER BY c.id LIMIT 1").get(HALE);
}

test("links in a case are collected, archived with a SHA-256, and unsafe hosts are never fetched", async () => {
	const c = haleCase();
	db.prepare("UPDATE cases SET evidence = ? WHERE id = ?").run(JSON.stringify([
		{ label: "Screenshot", url: "https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1" },
		{ label: "Clip", url: "https://streamable.com/abc123" },
		{ label: "Deleted clip", url: "https://medal.tv/clips/gone" },
		{ label: "Redirect trick", url: "https://imgur.com/evil" },
		{ label: "Random site", url: "https://example.org/x" }
	]), c.id);
	assert.ok(evidence.collectForCase(c.id) >= 5, "case evidence and transcript links are found");
	assert.equal(evidence.collectForCase(c.id), 0, "collection is idempotent");
	await drain();
	const byUrl = Object.fromEntries(evidence.forCase(c.id).map(i => [i.url, i]));

	const shot = byUrl["https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1"];
	assert.equal(shot.status, "archived");
	assert.equal(shot.sha256, require("crypto").createHash("sha256").update(PNG).digest("hex"));

	const clip = byUrl["https://streamable.com/abc123"];
	assert.equal(clip.status, "archived");
	assert.equal(clip.contentType, "video/mp4");
	assert.equal(clip.title, "Trooper rams civilian");
	assert.ok(clip.hasThumb);

	const gone = byUrl["https://medal.tv/clips/gone"];
	assert.equal(gone.status, "failed");
	assert.equal(gone.sourceStatus, "dead");

	assert.equal(byUrl["https://imgur.com/evil"].status, "failed");
	assert.match(byUrl["https://imgur.com/evil"].error, /not allow-listed/);
	assert.equal(byUrl["https://example.org/x"].status, "unsupported");
	assert.ok(!calls.some(u => u.includes("169.254") || u.includes("example.org")), "no request to unlisted hosts");
});

test("archived files are served to IA staff with range support, never to the subject", async () => {
	const c = haleCase();
	const item = evidence.forCase(c.id).find(i => i.contentType === "video/mp4");
	const inv = request.agent(app);
	await inv.get(`/auth/dev?as=${INVESTIGATOR}`).expect(302);
	const res = await inv.get(`/api/evidence/${item.id}/file`).expect(200);
	assert.equal(res.headers["content-type"], "video/mp4");
	const part = await inv.get(`/api/evidence/${item.id}/file`).set("Range", "bytes=0-9").expect(206);
	assert.equal(part.headers["content-length"], "10");
	const caseRes = await inv.get(`/api/cases/${c.ref}`).expect(200);
	assert.ok(caseRes.body.case.archive.length >= 5);

	const hale = request.agent(app);
	await hale.get(`/auth/dev?as=${HALE}`).expect(302);
	await hale.get(`/api/evidence/${item.id}/file`).expect(r => assert.ok([403, 404].includes(r.status)));
});

test("a source removed after archiving is flagged but the copy is kept", async () => {
	const c = haleCase();
	WEB["https://streamable.com/abc123"] = () => new Response("gone", { status: 404 });
	const row = db.prepare("SELECT * FROM evidence_archive WHERE url = 'https://streamable.com/abc123'").get();
	await evidence.checkSource(row);
	const item = evidence.forCase(c.id).find(i => i.url === "https://streamable.com/abc123");
	assert.equal(item.sourceStatus, "dead");
	assert.ok(item.hasFile);
	assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'evidence.source_removed'").get());
});
