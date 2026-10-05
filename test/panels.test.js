process.env.IA_DB_FILE = ":memory:";
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "none";

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { seedDemo } = require("../lib/seed");
const { createApp } = require("../lib/server");

seedDemo();
const app = createApp();

// Fake Discord: records which messages exist in which channel.
const bot = require("../lib/bot");
const messages = new Map();
let nextId = 1000;
bot.placePanel = async (channelId, messageId, buttons) => {
	if (channelId === "999999999999999999") throw new Error("The bot needs Send Messages in #locked");
	if (messageId && messages.has(messageId)) {
		messages.set(messageId, { channelId, buttons });
		return messageId;
	}
	const id = String(nextId++);
	messages.set(id, { channelId, buttons });
	return id;
};
bot.removePanel = async (channelId, messageId) => {
	messages.delete(messageId);
};

const DIRECTOR = "900000000000000001";
const SUPERVISOR = "900000000000000002";
const A = "111111111111111111";
const B = "222222222222222222";

async function agent(id) {
	const a = request.agent(app);
	await a.get(`/auth/dev?as=${id}`).expect(302);
	return a;
}
const send = (a, method, path, body) => a[method](path).set("X-IA-Request", "1").send(body);

test("only directors manage panels", async () => {
	await (await agent(SUPERVISOR)).get("/api/settings/panels").expect(403);
});

test("panels can be posted, changed, moved, kept in place, and removed", async () => {
	const d = await agent(DIRECTOR);

	let res = await send(d, "post", "/api/settings/panels", { channelId: A, buttons: ["report", "anon"] }).expect(200);
	assert.equal(res.body.panels.length, 1);
	const first = res.body.panels[0].messageId;
	assert.deepEqual(messages.get(first), { channelId: A, buttons: ["report", "anon"] });

	await send(d, "post", "/api/settings/panels", { channelId: B, buttons: [] }).expect(400);
	await send(d, "post", "/api/settings/panels", { channelId: "999999999999999999" }).expect(400);

	// Change buttons in place: same message is edited.
	res = await send(d, "patch", `/api/settings/panels/${A}`, { buttons: ["report", "anon", "ops"] }).expect(200);
	assert.equal(res.body.panels[0].messageId, first);
	assert.deepEqual(messages.get(first).buttons, ["report", "anon", "ops"]);

	// Move: new message in B, old one deleted.
	res = await send(d, "patch", `/api/settings/panels/${A}`, { channelId: B }).expect(200);
	const moved = res.body.panels[0];
	assert.equal(moved.channelId, B);
	assert.ok(!messages.has(first), "old panel message is deleted");
	assert.equal(messages.get(moved.messageId).channelId, B);

	// Someone deletes the message in Discord: a sync reposts it.
	messages.delete(moved.messageId);
	res = await send(d, "post", "/api/settings/panels/sync", {}).expect(200);
	assert.equal(res.body.result.reposted, 1);
	assert.ok(messages.has(res.body.panels[0].messageId));

	res = await send(d, "delete", `/api/settings/panels/${B}`).expect(200);
	assert.equal(res.body.panels.length, 0);
	assert.equal(messages.size, 0);
});
