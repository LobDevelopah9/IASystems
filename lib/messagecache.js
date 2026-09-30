// Rolling cache of members' messages in the SAHP server, captured live by the bot, so a personnel file can review
// more than the few hundred most recent messages Discord lets a bot page through quickly. Bounded by age
// (MESSAGE_CACHE_DAYS, default 120) and only kept for IA use in personnel files.
const { db, now } = require("./db");

db.exec(`
	CREATE TABLE IF NOT EXISTS message_cache (
		message_id TEXT PRIMARY KEY,
		channel_id TEXT NOT NULL,
		channel_name TEXT,
		author_id TEXT NOT NULL,
		author_name TEXT,
		content TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS message_cache_author ON message_cache(author_id, created_at);
	CREATE INDEX IF NOT EXISTS message_cache_age ON message_cache(created_at);
`);

const DAYS = Number(process.env.MESSAGE_CACHE_DAYS) || 120;
let lastPurge = 0;

function store(m) {
	if (!m?.id || !m.authorId || !String(m.content || "").trim()) return;
	db.prepare(`INSERT INTO message_cache (message_id, channel_id, channel_name, author_id, author_name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(message_id) DO UPDATE SET content = excluded.content`)
		.run(m.id, m.channelId, m.channelName || null, m.authorId, m.authorName || null, String(m.content).slice(0, 2000), m.createdAt || now());
	if (Date.now() - lastPurge > 3600000) {
		lastPurge = Date.now();
		db.prepare("DELETE FROM message_cache WHERE created_at < ?").run(now() - DAYS * 86400000);
	}
}

function forAuthor(authorId, limit = 2000) {
	return db.prepare("SELECT * FROM message_cache WHERE author_id = ? ORDER BY created_at DESC LIMIT ?").all(authorId, limit);
}

module.exports = { store, forAuthor, DAYS };
