// Identity linking: ties each personnel record to a Discord account and a ROBLOX account without the member doing
// anything. Sources, strongest first:
//   1. Bloxlink (BLOXLINK_API_KEY, a server API key from the Bloxlink dashboard) - the verified Discord↔ROBLOX link.
//   2. The member's server nickname in the SAHP format "RANK | CALLSIGN | RobloxName".
// Records for the same person (for example one imported from Trello and one created by the Discord sync) are linked
// with merged_into rather than rewritten, so signed cases keep their content hashes. The file shows all of them.
const { db, now } = require("./db");
const audit = require("./audit");

for (const [column, definition] of [["roblox_id", "TEXT"], ["merged_into", "INTEGER"], ["identity_source", "TEXT"], ["identity_checked_at", "INTEGER"]]) {
	if (!db.prepare("PRAGMA table_info(personnel)").all().some(c => c.name === column)) db.exec(`ALTER TABLE personnel ADD COLUMN ${column} ${definition}`);
}
if (!db.prepare("PRAGMA table_info(users)").all().some(c => c.name === "roblox_id")) db.exec("ALTER TABLE users ADD COLUMN roblox_id TEXT");

const KEY = process.env.BLOXLINK_API_KEY || "";
const ROBLOX_NAME = /^[A-Za-z0-9_]{3,20}$/;
const CALLSIGN = /^[0-9A-Z]{1,4}-?\d{1,4}[A-Z]?$/i;

function parseNickname(nick) {
	const parts = String(nick || "").split(/\s*[|│┃]\s*/).map(p => p.trim()).filter(Boolean);
	if (parts.length < 2) return {};
	const out = {};
	const last = parts[parts.length - 1].replace(/^@/, "");
	if (ROBLOX_NAME.test(last)) out.roblox = last;
	const callsign = parts.slice(0, -1).find(p => CALLSIGN.test(p) && /\d/.test(p));
	if (callsign) out.callsign = callsign.toUpperCase();
	if (parts[0] !== callsign && parts[0].length <= 16 && parts.length >= 3) out.rank = parts[0];
	return out;
}

// --- ROBLOX + Bloxlink lookups -----------------------------------------------------------------

async function getJson(url, headers = {}) {
	const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(10000) });
	if (response.status === 404) return null;
	if (response.status === 429) throw Object.assign(new Error("Rate limited"), { rateLimited: true });
	if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
	return response.json();
}

async function robloxName(id) {
	return (await getJson(`https://users.roblox.com/v1/users/${encodeURIComponent(id)}`))?.name || null;
}

async function robloxIdByName(name) {
	if (!ROBLOX_NAME.test(String(name || ""))) return null;
	const response = await fetch("https://users.roblox.com/v1/usernames/users", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }),
		signal: AbortSignal.timeout(10000)
	});
	if (!response.ok) return null;
	return String((await response.json()).data?.[0]?.id || "") || null;
}

function guildId() {
	return require("./policy").discordSettings().guildId;
}

async function bloxlinkDiscordToRoblox(discordId) {
	if (!KEY || !guildId()) return null;
	const data = await getJson(`https://api.blox.link/v4/public/guilds/${guildId()}/discord-to-roblox/${discordId}`, { Authorization: KEY });
	return data?.robloxID ? String(data.robloxID) : null;
}

async function bloxlinkRobloxToDiscord(robloxId) {
	if (!KEY || !guildId()) return null;
	const data = await getJson(`https://api.blox.link/v4/public/guilds/${guildId()}/roblox-to-discord/${robloxId}`, { Authorization: KEY });
	return Array.isArray(data?.discordIDs) && data.discordIDs.length ? String(data.discordIDs[0]) : null;
}

// --- Applying identities ----------------------------------------------------------------------

// Links other records for the same ROBLOX account (with no Discord of their own) to this one.
function linkDuplicates(person) {
	if (!person?.roblox_username && !person?.roblox_id) return 0;
	const dupes = db.prepare(`SELECT id, name FROM personnel WHERE id != ? AND merged_into IS NULL AND discord_id IS NULL
		AND ((? IS NOT NULL AND roblox_id = ?) OR (? IS NOT NULL AND lower(roblox_username) = lower(?)))`)
		.all(person.id, person.roblox_id, person.roblox_id, person.roblox_username, person.roblox_username);
	for (const d of dupes) {
		db.prepare("UPDATE personnel SET merged_into = ?, updated_at = ? WHERE id = ?").run(person.id, now(), d.id);
		db.prepare("UPDATE personnel SET merged_into = ? WHERE merged_into = ?").run(person.id, d.id);
		audit.record(null, "personnel.link", { type: "personnel", ref: String(person.id) }, { linked: d.id, name: d.name, roblox: person.roblox_username });
	}
	return dupes.length;
}

function apply(personId, { roblox, robloxId, rank, callsign, source }) {
	const p = db.prepare("SELECT * FROM personnel WHERE id = ?").get(personId);
	if (!p) return null;
	const sets = [];
	const values = [];
	const put = (column, value) => {
		if (value && value !== p[column]) {
			sets.push(`${column} = ?`);
			values.push(value);
		}
	};
	// Bloxlink is authoritative for the ROBLOX account; a nickname only fills gaps or tracks a rename.
	if (roblox && (source === "bloxlink" || !p.roblox_username || p.identity_source !== "bloxlink")) put("roblox_username", roblox);
	if (robloxId) put("roblox_id", robloxId);
	put("rank", rank);
	put("callsign", callsign);
	if (source && (source === "bloxlink" || p.identity_source !== "bloxlink")) put("identity_source", source);
	if (sets.length) db.prepare(`UPDATE personnel SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, now(), p.id);
	if (p.discord_id && (roblox || robloxId)) {
		db.prepare("UPDATE users SET roblox_username = COALESCE(?, roblox_username), roblox_id = COALESCE(?, roblox_id) WHERE discord_id = ?")
			.run(roblox || null, robloxId || null, p.discord_id);
	}
	const after = db.prepare("SELECT * FROM personnel WHERE id = ?").get(p.id);
	linkDuplicates(after);
	return after;
}

// Cheap, synchronous: called on every member sync.
function fromMember(personId, nickname) {
	const parsed = parseNickname(nickname);
	if (!parsed.roblox && !parsed.callsign) return null;
	return apply(personId, { ...parsed, source: "nickname" });
}

// Full resolution for one record, used by the background worker and before a personnel file is pulled.
async function resolve(personId) {
	let p = db.prepare("SELECT * FROM personnel WHERE id = ?").get(personId);
	if (!p) return null;
	if (p.merged_into) return resolve(p.merged_into);
	try {
		if (p.discord_id) {
			const robloxId = await bloxlinkDiscordToRoblox(p.discord_id);
			if (robloxId) {
				const name = await robloxName(robloxId);
				p = apply(p.id, { roblox: name, robloxId, source: "bloxlink" }) || p;
			} else if (p.roblox_username && !p.roblox_id) {
				p = apply(p.id, { robloxId: await robloxIdByName(p.roblox_username) }) || p;
			}
		} else if (p.roblox_username) {
			const robloxId = p.roblox_id || (await robloxIdByName(p.roblox_username));
			const discordId = robloxId ? await bloxlinkRobloxToDiscord(robloxId) : null;
			if (robloxId) p = apply(p.id, { robloxId }) || p;
			if (discordId) {
				const owner = db.prepare("SELECT * FROM personnel WHERE discord_id = ?").get(discordId);
				if (owner && owner.id !== p.id) {
					apply(owner.id, { roblox: p.roblox_username, robloxId, source: "bloxlink" });
					p = db.prepare("SELECT * FROM personnel WHERE id = ?").get(owner.id);
				} else if (!owner) {
					db.prepare("UPDATE personnel SET discord_id = ?, identity_source = 'bloxlink', updated_at = ? WHERE id = ?").run(discordId, now(), p.id);
					audit.record(null, "personnel.link", { type: "personnel", ref: String(p.id) }, { discordId, via: "bloxlink" });
					p = db.prepare("SELECT * FROM personnel WHERE id = ?").get(p.id);
				}
			}
		}
	} catch (error) {
		if (error.rateLimited) throw error;
		console.warn(`[identity] ${p.name}: ${error.message}`);
	}
	db.prepare("UPDATE personnel SET identity_checked_at = ? WHERE id = ?").run(now(), p.id);
	return p;
}

// Every record id that belongs to this person (the canonical record plus linked duplicates).
function aliasIds(personId) {
	return [Number(personId), ...db.prepare("SELECT id FROM personnel WHERE merged_into = ?").all(personId).map(r => r.id)];
}

function canonicalId(personId) {
	const p = db.prepare("SELECT id, merged_into FROM personnel WHERE id = ?").get(Number(personId));
	return p?.merged_into || p?.id || null;
}

// --- Worker -------------------------------------------------------------------------------------

let timer = null;
let pausedUntil = 0;
let busy = false;

async function work() {
	if (busy || !KEY || Date.now() < pausedUntil) return;
	busy = true;
	try {
		const next = db.prepare(`SELECT id FROM personnel WHERE merged_into IS NULL AND demo = 0 AND (discord_id IS NOT NULL OR roblox_username IS NOT NULL)
			AND COALESCE(identity_checked_at, 0) < ? ORDER BY identity_checked_at IS NOT NULL, identity_checked_at LIMIT 1`).get(now() - 7 * 86400000);
		if (next) await resolve(next.id);
	} catch (error) {
		if (error.rateLimited) pausedUntil = Date.now() + 60000;
	} finally {
		busy = false;
	}
}

function start() {
	// Nickname pass for everyone already synced (no network).
	const rows = db.prepare("SELECT p.id, u.display_name FROM personnel p JOIN users u ON u.discord_id = p.discord_id WHERE p.merged_into IS NULL").all();
	let linked = 0;
	for (const r of rows) if (fromMember(r.id, r.display_name)) linked++;
	if (linked) console.log(`[identity] read ROBLOX/callsign from ${linked} nickname(s)`);
	console.log(`[identity] Bloxlink ${KEY ? "enabled" : "not configured (set BLOXLINK_API_KEY)"}`);
	timer = setInterval(() => work().catch(() => {}), 4000);
	timer.unref?.();
}

function status() {
	const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(roblox_username IS NOT NULL) AS roblox, SUM(discord_id IS NOT NULL) AS discord,
		SUM(identity_source = 'bloxlink') AS bloxlink FROM personnel WHERE merged_into IS NULL AND demo = 0`).get();
	return { bloxlink: Boolean(KEY), ...counts };
}

module.exports = { parseNickname, fromMember, resolve, apply, linkDuplicates, aliasIds, canonicalId, start, status, work };
