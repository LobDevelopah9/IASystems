process.env.IA_DB_FILE = ":memory:";
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { db } = require("../lib/db");
const tickets = require("../lib/tickets");
const bot = require("../lib/bot");

const msg = (id, author, content, at) => ({
	id, content, createdTimestamp: at, embeds: [], attachments: new Map(),
	author: { id: author, username: author, globalName: author, bot: false }, member: null
});

test("live-captured and fetched messages merge into one ordered transcript", async () => {
	const t = tickets.openTicket({ type: "report", openerId: "a", openerName: "A", intake: {} });
	// Live capture sees messages 2 and 3 only; the close-time fetch returns 1-3.
	await bot.storeMessage(t, msg("2", "b", "second", 2000));
	await bot.storeMessage(t, msg("3", "a", "third", 3000));
	for (const m of [msg("3", "a", "third", 3000), msg("2", "b", "second", 2000), msg("1", "a", "first", 1000)]) await bot.storeMessage(t, m);
	bot.resequence(t.id);
	const rows = db.prepare("SELECT seq, content FROM ticket_messages WHERE ticket_id = ? ORDER BY seq").all(t.id);
	assert.deepStrictEqual(rows.map(r => `${r.seq}:${r.content}`), ["1:first", "2:second", "3:third"]);
	assert.strictEqual(db.prepare("SELECT message_count FROM tickets WHERE id = ?").get(t.id).message_count, 3);
});
