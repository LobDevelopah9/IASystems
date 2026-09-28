const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert");

// Primary: an OpenAI-compatible endpoint that is always overloaded. Fallback: one that answers.
const calls = [];
function server(handler) {
	const s = http.createServer((req, res) => {
		let body = "";
		req.on("data", c => { body += c; });
		req.on("end", () => handler(req, res, body ? JSON.parse(body) : {}));
	});
	return s;
}
const overloaded = server((req, res) => {
	calls.push("primary");
	res.writeHead(503, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: { message: "This model is currently experiencing high demand." } }));
});
const healthy = server((req, res, body) => {
	calls.push(`fallback:${body.model}`);
	const userText = body.messages.at(-1).content;
	const ref = (userText.match(/\[(T-\d{4}#\d+)\]/) || [])[1];
	const content = JSON.stringify({
		decision: { finding: "sustained", punishments: ["black_mark"], punishment_detail: "X1", appealable: true, rationale: "ok", confidence: "high" },
		report: { ticket_details: { text: "Details.", sources: [ref] }, conclusion: { text: "Conclusion.", sources: [] }, accused_statement: { text: "", sources: [] } }
	});
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});

test("drafting falls back to the backup provider when the primary is overloaded", async () => {
	await new Promise(r => overloaded.listen(0, r));
	await new Promise(r => healthy.listen(0, r));
	process.env.IA_DB_FILE = ":memory:";
	process.env.NODE_ENV = "test";
	process.env.AI_PROVIDER = "openai";
	process.env.AI_API_KEY = "k1";
	process.env.AI_MODEL = "primary-model";
	process.env.AI_BASE_URL = `http://127.0.0.1:${overloaded.address().port}/v1`;
	process.env.AI_FALLBACK_PROVIDER = "openai";
	process.env.AI_FALLBACK_API_KEY = "k2";
	process.env.AI_FALLBACK_MODEL = "backup-model";
	process.env.AI_FALLBACK_BASE_URL = `http://127.0.0.1:${healthy.address().port}/v1`;
	const ai = require("../lib/ai");
	const { punishments } = require("../lib/policy");
	const bundle = [{ ticket: { ref: "T-0001", type: "report", anonymous: 0, opened_at: Date.now() }, intake: {}, messages: [{ ref: "T-0001#1", author: "A", authorRole: "reporter", content: "hello", attachments: [], createdAt: Date.now() }] }];
	const out = await ai.draft({ bundle, punishments: punishments(), context: {} });
	assert.strictEqual(out.model, "backup-model");
	assert.match(out.fellBackFrom, /high demand/);
	assert.deepStrictEqual(calls, ["primary", "fallback:backup-model"]);
	assert.strictEqual(ai.providerInfo().fallback.model, "backup-model");
	for (const s of [overloaded, healthy]) { s.closeAllConnections(); s.close(); }
});

test("first-person drafts are rejected so the model retries in the third person", () => {
	const { validate } = require("../lib/ai");
	const { punishments } = require("../lib/policy");
	const base = { decision: { finding: "sustained", punishments: ["black_mark"], appealable: true, rationale: "r" } };
	const ctx = { punishments: punishments(), validRefs: new Set(["T-0001#1"]), messageText: new Map([["T-0001#1", "x"]]) };
	const first = validate({ ...base, report: { ticket_details: { text: "I claimed the ticket and asked the reporter." }, conclusion: { text: "The evidence supports it." } } }, ctx);
	assert.ok(first.problems.some(p => /third person/.test(p)));
	const quoted = validate({ ...base, report: { ticket_details: { text: "The accused stated \"I did not hear it\" (T-0001#1)." }, conclusion: { text: "The Office of Professional Standards recommends X1 Black Mark." } } }, ctx);
	assert.deepStrictEqual(quoted.problems, [], "first person inside direct quotes is allowed");
});
