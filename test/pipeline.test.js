const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert");

// A fake OpenAI-compatible model that echoes back refs it sees in the prompt.
let lastPrompt = "";
const mock = http.createServer((req, res) => {
	let body = "";
	req.on("data", chunk => { body += chunk; });
	req.on("end", () => {
		const parsed = JSON.parse(body);
		lastPrompt = parsed.messages.map(m => m.content).join("\n");
		const userText = parsed.messages.at(-1).content;
		const refs = [...new Set(userText.match(/\[T-\d{4}#\d+\]/g).map(r => r.slice(1, -1)))];
		const quoteLine = userText.split("\n").find(l => l.startsWith(`[${refs[1]}]`)) || "";
		const quote = quoteLine.split(": ").slice(1).join(": ");
		const content = JSON.stringify({
			decision: { finding: "sustained", punishments: ["black_mark", "fto"], punishment_detail: "X1 Black Mark", appealable: true, rationale: "Evidence supports it.", confidence: "high" },
			report: {
				title: "PT Test: Reckless Driving",
				classification: "Anonymous Trooper Report",
				accused_violations: ["Reckless Driving"],
				ticket_details: { text: "Summary text.", sources: [refs[1], "T-9999#9"] },
				accused_statement: { text: "No statement.", sources: [] },
				conclusion: { text: "After collecting both statements, X1 Black Mark and FTO.", sources: [refs[1]] },
				interview_notes: "N/A",
				timeline: [{ when: "Day 1", event: "Something happened.", sources: [refs[1]] }],
				excerpts: [{ ref: refs[1], speaker: "Secret Reporter", quote, relevance: "core" }],
				location: { text: "Route 68", sources: [refs[1]] },
				incident_time: "Day 1",
				incident_location: "Route 68"
			}
		});
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content } }] }));
	});
});

test("closing a ticket drafts a report-style case in Marked for Review", async () => {
	await new Promise(resolve => mock.listen(0, resolve));
	process.env.IA_DB_FILE = ":memory:";
	process.env.NODE_ENV = "test";
	process.env.AI_PROVIDER = "openai";
	process.env.AI_API_KEY = "test";
	process.env.AI_MODEL = "mock";
	process.env.AI_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;

	const { db } = require("../lib/db");
	const tickets = require("../lib/tickets");
	const pipeline = require("../lib/pipeline");

	const subject = tickets.findOrCreatePersonnel({ name: "Tpr. Test Subject" });
	const t = tickets.openTicket({ type: "report", openerId: "111111111111111111", openerName: "Secret Reporter", anonymous: true, subjectPersonnelId: subject.id, intake: { allegation: "Speeding", details: "Secret Reporter saw it" } });
	tickets.storeTranscript(t.id, [
		{ authorId: "999", authorName: "Bot", isBot: true, content: "Report received" },
		{ authorId: "111111111111111111", authorName: "Secret Reporter", content: "I, Secret Reporter, saw Tpr. Test Subject speeding on Route 68. Clip: https://medal.tv/games/roblox/clips/abc123" }
	]);
	const outcome = tickets.closeTicket(t.id, null, "done");
	assert.strictEqual(outcome.action, "created");

	await pipeline.tick();
	const row = db.prepare("SELECT * FROM cases WHERE ref = ?").get(outcome.caseRef);
	assert.strictEqual(row.ai_state, "ready", row.ai_error);
	assert.strictEqual(row.status, "marked_for_review");
	assert.strictEqual(row.anonymous, 1);
	assert.strictEqual(row.narrative_summary, "Summary text.");
	assert.deepStrictEqual(JSON.parse(row.narrative_sources).summary, [`${t.ref}#2`], "invented refs are dropped");
	assert.strictEqual(JSON.parse(row.narrative_excerpts).length, 1, "verbatim excerpt kept");
	assert.ok(lastPrompt.includes("ANONYMOUS REPORT (reporter: Secret Reporter)"), "the report names the anonymous reporter for IA");
	assert.ok(lastPrompt.includes("first person"), "style guide is in the prompt");
	assert.ok(lastPrompt.includes("[REPORTING PARTY] Secret Reporter"), "authors are tagged with their role");
	assert.ok(lastPrompt.includes("[BOT] Bot"), "bot lines are tagged");
	assert.ok(lastPrompt.includes(" EST)"), "times are given in EST");
	assert.strictEqual(row.conclusion, "After collecting both statements, X1 Black Mark and FTO.");
	assert.deepStrictEqual(JSON.parse(row.violations), ["Reckless Driving"]);
	assert.ok(JSON.parse(row.evidence).some(e => e.url === "https://medal.tv/games/roblox/clips/abc123"), "clip links become evidence");
	const decision = db.prepare("SELECT * FROM ai_decisions WHERE case_id = ?").get(row.id);
	assert.strictEqual(decision.punishment, "black_mark,fto");
	assert.match(decision.signature, /recommendation only/);
	mock.closeAllConnections();
	mock.close();
});
