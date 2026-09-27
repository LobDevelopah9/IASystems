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

const IDS = {
	director: "900000000000000001",
	supervisor: "900000000000000002",
	investigator: "900000000000000003",
	investigator2: "900000000000000004",
	trooperHale: "900000000000000005",
	trooperCortez: "900000000000000006"
};

async function agent(id) {
	const a = request.agent(app);
	await a.get(`/auth/dev?as=${id}`).expect(302);
	return a;
}
const get = (a, path) => a.get(path);
const post = (a, path, body) => a.post(path).set("X-IA-Request", "1").send(body);
const patch = (a, path, body) => a.patch(path).set("X-IA-Request", "1").send(body);

test("unauthenticated requests are rejected", async () => {
	await request(app).get("/api/cases").expect(401);
	await request(app).get("/api/cases/9001").expect(401);
});

test("mutations without the portal header are blocked (CSRF)", async () => {
	const a = await agent(IDS.supervisor);
	await a.post("/api/cases/9002/notes").send({ body: "x" }).expect(403);
});

test("troopers cannot reach the IA board, tickets, or other cases", async () => {
	const a = await agent(IDS.trooperCortez);
	await get(a, "/api/cases").expect(403);
	await get(a, "/api/tickets").expect(403);
	await get(a, "/api/cases/9003").expect(404);
	await get(a, "/api/users").expect(403);
	await get(a, "/api/audit").expect(403);
});

test("a subject only sees the member view of their own approved cases", async () => {
	const a = await agent(IDS.trooperHale);
	const mine = await get(a, "/api/my/cases").expect(200);
	assert.deepStrictEqual(mine.body.cases.map(c => c.ref), ["9004"]);
	const view = mine.body.cases[0];
	assert.strictEqual(view.view, "subject");
	for (const hidden of ["narrative", "ai", "reporter", "tickets", "notes"]) assert.ok(!(hidden in view), `${hidden} must not be exposed`);
	// Case still under review is invisible to the subject.
	await get(a, "/api/cases/9001").expect(404);
});

test("every IA agent sees an anonymous reporter, including in search and transcripts", async () => {
	const a = await agent(IDS.investigator);
	const res = await get(a, "/api/cases/9001").expect(200);
	assert.strictEqual(res.body.case.reporter.name, "Tpr. Casey Lindqvist");
	assert.strictEqual(res.body.case.reporter.anonymous, true);
	const board = await get(a, "/api/cases?q=Lindqvist").expect(200);
	assert.deepStrictEqual(board.body.cases.map(c => c.ref), ["9001"]);
	const t = await get(a, "/api/cases/9001/transcripts/T-0001").expect(200);
	assert.ok(t.body.messages.some(m => m.author === "Tpr. Casey Lindqvist"));
});

test("the accused never sees the anonymous reporter, even once the case is approved", async () => {
	const sup = await agent(IDS.supervisor);
	await post(sup, "/api/cases/9001/sign", { finding: "sustained", punishment: "black_mark,fto", punishmentDetail: "X1 Black Mark", appealable: true, typedName: "Lt. Daniel Brooks" }).expect(200);
	const hale = await agent(IDS.trooperHale);
	const mine = await get(hale, "/api/my/cases").expect(200);
	assert.ok(mine.body.cases.some(c => c.ref === "9001"));
	const body = JSON.stringify(mine.body);
	for (const leak of ["Lindqvist", "CaseyLindq", "lindq", "Ticket Details", "narrative"]) assert.ok(!body.includes(leak), `${leak} leaked to the accused`);
	await get(hale, "/api/cases/9001/transcripts/T-0001").expect(403);
	await get(hale, "/api/tickets/T-0001").expect(403);
	// Put the case back for the tests below.
	await patch(sup, "/api/cases/9001", { changes: { narrative_summary: "reset" }, reason: "test reset" }).expect(200);
});

test("investigators cannot sign, assign, or manage users", async () => {
	const a = await agent(IDS.investigator);
	await post(a, "/api/cases/9001/sign", { finding: "sustained", punishment: "black_mark", typedName: "Det. Priya Nair" }).expect(403);
	await post(a, "/api/cases/9001/assign", { agentId: IDS.investigator }).expect(403);
	await patch(a, `/api/users/${IDS.investigator2}`, { override: "director" }).expect(403);
	await patch(a, "/api/cases/9001", { changes: { final_punishment: "black_mark" } }).expect(403);
});

test("approval only happens through a signature, and signing requires the typed name", async () => {
	const a = await agent(IDS.supervisor);
	await post(a, "/api/cases/9001/status", { to: "approved" }).expect(409);
	await post(a, "/api/cases/9001/sign", { finding: "sustained", punishment: "black_mark,fto", typedName: "someone else" }).expect(400);
	const res = await post(a, "/api/cases/9001/sign", { finding: "sustained", punishment: "black_mark,fto", appealable: true, typedName: "Lt. Daniel Brooks" }).expect(200);
	assert.strictEqual(res.body.case.status, "approved");
	assert.strictEqual(res.body.case.signatureState, "valid");
	assert.strictEqual(res.body.case.report.punishmentsIssued, "Black Mark + FTO (X1 Black Mark)".replace(" (X1 Black Mark)", ""));
	assert.strictEqual(res.body.case.report.evidenceSupports, "YES");
});

test("case numbers continue the paper series and accept #-style lookups", async () => {
	const a = await agent(IDS.supervisor);
	const created = await post(a, "/api/cases", { title: "PT Robin13031: Unprofessionalism", subjectName: "Robin13031", violations: ["Unprofessionalism"] }).expect(201);
	assert.strictEqual(created.body.ref, "0644");
	await get(a, "/api/cases/%230644").expect(200);
	await get(a, "/api/cases/644").expect(200);
	const second = await post(a, "/api/cases", { title: "Second", subjectName: "Someone" }).expect(201);
	assert.strictEqual(second.body.ref, "0645");
});

test("editing signed content invalidates the signature and returns the case to review", async () => {
	const a = await agent(IDS.supervisor);
	await patch(a, "/api/cases/9001", { changes: { narrative_summary: "changed" } }).expect(400);
	const res = await patch(a, "/api/cases/9001", { changes: { narrative_summary: "changed" }, reason: "Correction" }).expect(200);
	assert.strictEqual(res.body.case.signatureState, "stale");
	assert.strictEqual(res.body.case.status, "marked_for_review");
	assert.strictEqual(res.body.case.signatures[0].stale, true);
});

test("closing requires a valid signature", async () => {
	const a = await agent(IDS.supervisor);
	await post(a, "/api/cases/9002/status", { to: "closed" }).expect(403);
});

test("signatures, AI decisions, and the audit log are immutable at the database level", () => {
	assert.throws(() => db.prepare("UPDATE signatures SET signer_name = 'x'").run(), /immutable/);
	assert.throws(() => db.prepare("UPDATE ai_decisions SET punishment = 'x'").run(), /immutable/);
	assert.throws(() => db.prepare("DELETE FROM audit_log").run(), /append-only/);
	assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x'").run(), /append-only/);
});

test("a supervisor is recused from cases where they are the reporter", async () => {
	const a = await agent(IDS.supervisor);
	const res = await get(a, "/api/cases/9004").expect(200);
	assert.ok(res.body.case.permissions.recused);
});

test("closed cases are locked for edits", async () => {
	const a = await agent(IDS.director);
	await patch(a, "/api/cases/9004", { changes: { title: "x" }, reason: "x" }).expect(409);
});

test("every case view is audited and the chain verifies", async () => {
	const a = await agent(IDS.director);
	const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'case.view'").get().n;
	await get(a, "/api/cases/9003").expect(200);
	const after = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'case.view'").get().n;
	assert.strictEqual(after, before + 1);
	const audit = await get(a, "/api/audit?verify=1").expect(200);
	assert.strictEqual(audit.body.chain.ok, true);
});

test("the director cannot demote themselves or leave the portal without a director", async () => {
	const a = await agent(IDS.director);
	await patch(a, `/api/users/${IDS.director}`, { override: "trooper" }).expect(403);
	await patch(a, `/api/users/${IDS.investigator2}`, { callsign: "IA-99" }).expect(200);
});

test("suspending a user revokes their sessions immediately", async () => {
	const victim = await agent(IDS.investigator2);
	await get(victim, "/api/cases").expect(200);
	const director = await agent(IDS.director);
	await patch(director, `/api/users/${IDS.investigator2}`, { suspended: true, reason: "test" }).expect(200);
	await get(victim, "/api/cases").expect(401);
	await patch(director, `/api/users/${IDS.investigator2}`, { suspended: false }).expect(200);
});

test("API responses are never cached", async () => {
	const a = await agent(IDS.supervisor);
	const res = await get(a, "/api/cases/9003").expect(200);
	assert.match(res.headers["cache-control"], /no-store/);
});

test("AI output validation drops invented refs and non-verbatim quotes", () => {
	const { validate } = require("../lib/ai");
	const { punishments } = require("../lib/policy");
	const { result, problems } = validate({
		decision: { finding: "sustained", punishments: ["black_mark", "fto"], appealable: true, rationale: "r" },
		report: {
			ticket_details: { text: "s", sources: ["T-0001#1", "T-9999#1"] },
			conclusion: { text: "c", sources: [] },
			accused_violations: ["Unprofessionalism"],
			timeline: [{ when: "x", event: "e", sources: ["T-0001#2"] }],
			excerpts: [{ ref: "T-0001#1", speaker: "a", quote: "hello there" }, { ref: "T-0001#1", speaker: "a", quote: "invented words" }]
		}
	}, { punishments: punishments(), validRefs: new Set(["T-0001#1", "T-0001#2"]), messageText: new Map([["T-0001#1", "Well, Hello   there friend"], ["T-0001#2", "x"]]) });
	assert.deepStrictEqual(problems, []);
	assert.deepStrictEqual(result.narrative.summary.sources, ["T-0001#1"]);
	assert.strictEqual(result.narrative.excerpts.length, 1);
	assert.strictEqual(result.decision.punishment, "black_mark,fto");
	assert.deepStrictEqual(result.narrative.violations, ["Unprofessionalism"]);
});

test("owners can delete unsigned cases only, and the purge is audited", async () => {
	process.env.IA_OWNER_DISCORD_IDS = "";
	const director = await agent(IDS.director);
	const created = await post(director, "/api/cases", { title: "Test to delete", subjectName: "Nobody Special" }).expect(201);
	// Directors who are not owners cannot delete.
	await director.delete(`/api/cases/${created.body.ref}`).set("X-IA-Request", "1").send({ confirm: `DELETE ${created.body.ref}` }).expect(403);
	const config = require("../lib/config");
	config.OWNER_DISCORD_IDS.push(IDS.director);
	await director.delete(`/api/cases/${created.body.ref}`).set("X-IA-Request", "1").send({ confirm: "nope" }).expect(400);
	await director.delete(`/api/cases/${created.body.ref}`).set("X-IA-Request", "1").send({ confirm: `DELETE ${created.body.ref}` }).expect(200);
	await get(director, `/api/cases/${created.body.ref}`).expect(404);
	// Signed cases are permanent.
	await director.delete("/api/cases/9003").set("X-IA-Request", "1").send({ confirm: "DELETE 9003" }).expect(409);
	assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'case.delete'").get());
	config.OWNER_DISCORD_IDS.pop();
});

test("owner accounts bypass recusal and subject rules, and the bypass is audited", async () => {
	const config = require("../lib/config");
	config.OWNER_DISCORD_IDS.push(IDS.supervisor);
	const a = await agent(IDS.supervisor);
	// Lt. Brooks filed the report on 9004: normally recused.
	const res = await get(a, "/api/cases/9004").expect(200);
	assert.strictEqual(res.body.case.permissions.recused, null);
	assert.strictEqual(res.body.case.permissions.ownerOverride, true);
	assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'case.view' AND target_ref = '9004' AND detail LIKE '%ownerOverride%'").get());
	config.OWNER_DISCORD_IDS.pop();
	const again = await get(a, "/api/cases/9004").expect(200);
	assert.ok(again.body.case.permissions.recused, "non-owners stay recused");
});

test("an owner who is the accused sees the full IA file, and the member view still works for them", async () => {
	const config = require("../lib/config");
	config.OWNER_DISCORD_IDS.push(IDS.trooperHale);
	const hale = await agent(IDS.trooperHale);
	const full = await get(hale, "/api/cases/9004").expect(200);
	assert.strictEqual(full.body.case.view, "ia");
	const mine = await get(hale, "/api/my/cases").expect(200);
	assert.ok(mine.body.cases.every(c => c.view === "subject"));
	config.OWNER_DISCORD_IDS.pop();
});
