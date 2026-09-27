const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { DATA_DIR } = require("./config");

const STATUSES = ["marked_for_review", "under_investigation", "approved", "appealed", "closed"];

function open(file) {
	if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new Database(file);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("trusted_schema = OFF");
	db.pragma("secure_delete = ON");
	migrate(db);
	return db;
}

function migrate(db) {
	db.exec(`
	CREATE TABLE IF NOT EXISTS users (
		discord_id TEXT PRIMARY KEY,
		username TEXT NOT NULL,
		display_name TEXT,
		avatar TEXT,
		discord_roles TEXT NOT NULL DEFAULT '[]',
		mapped_role TEXT NOT NULL DEFAULT 'none',
		role_override TEXT,
		suspended INTEGER NOT NULL DEFAULT 0,
		suspended_reason TEXT,
		in_guild INTEGER NOT NULL DEFAULT 1,
		callsign TEXT,
		badge_number TEXT,
		title TEXT,
		roblox_username TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		last_login_at INTEGER,
		last_seen_at INTEGER,
		demo INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS sessions (
		id_hash TEXT PRIMARY KEY,
		discord_id TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL,
		ip TEXT,
		user_agent TEXT,
		revoked INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS sessions_user ON sessions(discord_id);

	CREATE TABLE IF NOT EXISTS oauth_states (
		state TEXT PRIMARY KEY,
		verifier TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		updated_by TEXT
	);

	CREATE TABLE IF NOT EXISTS personnel (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		discord_id TEXT UNIQUE,
		name TEXT NOT NULL,
		callsign TEXT,
		roblox_username TEXT,
		discord_username TEXT,
		rank TEXT,
		department TEXT NOT NULL DEFAULT 'SAHP',
		notes TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		demo INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS link_groups (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		created_by TEXT,
		created_at INTEGER NOT NULL,
		case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
		demo INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS tickets (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ref TEXT UNIQUE,
		type TEXT NOT NULL CHECK(type IN ('report', 'interview', 'ops')),
		status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
		guild_id TEXT,
		channel_id TEXT,
		opener_id TEXT,
		opener_name TEXT,
		opener_username TEXT,
		anonymous INTEGER NOT NULL DEFAULT 0,
		subject_personnel_id INTEGER REFERENCES personnel(id) ON DELETE SET NULL,
		subject_text TEXT,
		intake TEXT NOT NULL DEFAULT '{}',
		link_group_id INTEGER REFERENCES link_groups(id) ON DELETE SET NULL,
		target_case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
		opened_at INTEGER NOT NULL,
		closed_at INTEGER,
		closed_by TEXT,
		close_reason TEXT,
		message_count INTEGER NOT NULL DEFAULT 0,
		demo INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS tickets_channel ON tickets(channel_id);

	CREATE TABLE IF NOT EXISTS ticket_messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
		seq INTEGER NOT NULL,
		message_id TEXT,
		author_id TEXT,
		author_name TEXT,
		is_bot INTEGER NOT NULL DEFAULT 0,
		content TEXT NOT NULL DEFAULT '',
		attachments TEXT NOT NULL DEFAULT '[]',
		created_at INTEGER NOT NULL,
		UNIQUE(ticket_id, seq)
	);

	CREATE TABLE IF NOT EXISTS ticket_attachments (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
		seq INTEGER NOT NULL,
		filename TEXT NOT NULL,
		content_type TEXT,
		size INTEGER,
		stored_path TEXT,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS cases (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ref TEXT UNIQUE,
		case_number INTEGER,
		status TEXT NOT NULL DEFAULT 'marked_for_review'
			CHECK(status IN ('marked_for_review', 'under_investigation', 'approved', 'appealed', 'closed')),
		kind TEXT NOT NULL DEFAULT 'misconduct' CHECK(kind IN ('misconduct', 'ops')),
		title TEXT NOT NULL,
		classification TEXT NOT NULL DEFAULT 'Standard Trooper Report',
		violations TEXT NOT NULL DEFAULT '[]',
		subject_personnel_id INTEGER REFERENCES personnel(id) ON DELETE SET NULL,
		reporter_id TEXT,
		reporter_name TEXT,
		reporter_username TEXT,
		reporter_roblox TEXT,
		anonymous INTEGER NOT NULL DEFAULT 0,
		incident_at TEXT NOT NULL DEFAULT '',
		incident_location TEXT NOT NULL DEFAULT '',
		assigned_agent_id TEXT REFERENCES users(discord_id) ON DELETE SET NULL,
		created_by TEXT,
		created_via TEXT NOT NULL DEFAULT 'portal',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		narrative_summary TEXT NOT NULL DEFAULT '',
		narrative_timeline TEXT NOT NULL DEFAULT '[]',
		narrative_excerpts TEXT NOT NULL DEFAULT '[]',
		narrative_interview TEXT NOT NULL DEFAULT '',
		narrative_location TEXT NOT NULL DEFAULT '',
		narrative_sources TEXT NOT NULL DEFAULT '{}',
		conclusion TEXT NOT NULL DEFAULT '',
		evidence TEXT NOT NULL DEFAULT '[]',
		interview_location TEXT NOT NULL DEFAULT 'Ticket',
		interview_present TEXT NOT NULL DEFAULT '',
		interview_notes TEXT NOT NULL DEFAULT '',
		narrative_human_edited INTEGER NOT NULL DEFAULT 0,
		ai_state TEXT NOT NULL DEFAULT 'none' CHECK(ai_state IN ('none', 'queued', 'drafting', 'ready', 'failed')),
		ai_error TEXT,
		pending_draft_id INTEGER,
		final_finding TEXT,
		final_punishment TEXT,
		final_punishment_detail TEXT,
		final_appealable INTEGER,
		subject_notice TEXT NOT NULL DEFAULT '',
		approved_at INTEGER,
		closed_at INTEGER,
		demo INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS cases_status ON cases(status);

	CREATE TABLE IF NOT EXISTS case_tickets (
		case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
		ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
		added_by TEXT,
		added_at INTEGER NOT NULL,
		PRIMARY KEY(case_id, ticket_id)
	);

	CREATE TABLE IF NOT EXISTS case_notes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
		author_id TEXT,
		author_name TEXT,
		body TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS case_edits (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
		editor_id TEXT,
		editor_name TEXT,
		field TEXT NOT NULL,
		before TEXT,
		after TEXT,
		reason TEXT,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS ai_drafts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		provider TEXT,
		model TEXT,
		status TEXT NOT NULL CHECK(status IN ('ok', 'failed')),
		output TEXT,
		error TEXT,
		input_chars INTEGER
	);

	CREATE TABLE IF NOT EXISTS ai_decisions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
		draft_id INTEGER REFERENCES ai_drafts(id) ON DELETE SET NULL,
		finding TEXT NOT NULL,
		punishment TEXT NOT NULL,
		punishment_detail TEXT NOT NULL DEFAULT '',
		appealable INTEGER NOT NULL,
		rationale TEXT NOT NULL DEFAULT '',
		signature TEXT NOT NULL,
		model TEXT,
		content_hash TEXT NOT NULL,
		signed_at INTEGER NOT NULL,
		demo INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS signatures (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
		signer_id TEXT NOT NULL,
		signer_name TEXT NOT NULL,
		signer_title TEXT,
		finding TEXT NOT NULL,
		punishment TEXT NOT NULL,
		punishment_detail TEXT NOT NULL DEFAULT '',
		appealable INTEGER NOT NULL,
		statement TEXT NOT NULL DEFAULT '',
		content_hash TEXT NOT NULL,
		signed_at INTEGER NOT NULL,
		demo INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS appeals (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
		requested_by TEXT NOT NULL,
		reason TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'denied')),
		created_at INTEGER NOT NULL,
		resolved_by TEXT,
		resolved_at INTEGER
	);

	CREATE TABLE IF NOT EXISTS audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL,
		actor_id TEXT,
		actor_name TEXT,
		action TEXT NOT NULL,
		target_type TEXT,
		target_ref TEXT,
		detail TEXT NOT NULL DEFAULT '{}',
		ip TEXT,
		prev_hash TEXT NOT NULL,
		hash TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS audit_target ON audit_log(target_type, target_ref);

	CREATE TABLE IF NOT EXISTS jobs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		payload TEXT NOT NULL DEFAULT '{}',
		status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'done', 'failed')),
		attempts INTEGER NOT NULL DEFAULT 0,
		run_after INTEGER NOT NULL,
		last_error TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE VIRTUAL TABLE IF NOT EXISTS cases_fts USING fts5(
		case_id UNINDEXED, ref, title, subject, reporter, location, body,
		tokenize = 'unicode61 remove_diacritics 2'
	);

	-- Immutable records: audit trail, signatures, and AI recommendations can never be altered.
	-- Only rows flagged as demo data may be deleted (so seed data can be purged).
	CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
		BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
	CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
		BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
	CREATE TRIGGER IF NOT EXISTS signatures_no_update BEFORE UPDATE ON signatures
		BEGIN SELECT RAISE(ABORT, 'signatures are immutable'); END;
	CREATE TRIGGER IF NOT EXISTS signatures_no_delete BEFORE DELETE ON signatures WHEN OLD.demo = 0
		BEGIN SELECT RAISE(ABORT, 'signatures are immutable'); END;
	CREATE TRIGGER IF NOT EXISTS ai_decisions_no_update BEFORE UPDATE ON ai_decisions
		BEGIN SELECT RAISE(ABORT, 'AI recommendations are immutable'); END;
	CREATE TRIGGER IF NOT EXISTS ai_decisions_no_delete BEFORE DELETE ON ai_decisions WHEN OLD.demo = 0
		BEGIN SELECT RAISE(ABORT, 'AI recommendations are immutable'); END;
	`);
}

const db = open(process.env.IA_DB_FILE || path.join(DATA_DIR, "ia.sqlite"));

const now = () => Date.now();
const json = (value, fallback) => {
	try {
		return value == null ? fallback : JSON.parse(value);
	} catch {
		return fallback;
	}
};

function getSetting(key, fallback) {
	const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
	return row ? json(row.value, fallback) : fallback;
}

function setSetting(key, value, actorId) {
	db.prepare(`
		INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
	`).run(key, JSON.stringify(value), now(), actorId || null);
}

module.exports = { db, now, json, getSetting, setSetting, STATUSES };
