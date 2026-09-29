// Evidence archive. Links in ticket transcripts and case evidence lists (clips, screenshots, Discord CDN files)
// are downloaded into the IA volume so evidence survives deleted clips and expiring links. Every stored file is
// content-addressed by SHA-256 so its integrity can be shown later. Sources are re-checked periodically; a clip
// deleted after it was reported is recorded, because that is itself relevant to an investigation.
//
// SSRF: only allow-listed public hosts are ever fetched, over HTTPS, with every redirect hop re-checked.
// Stored files must pass the magic-byte allowlist (raster images, video, audio). Nothing else is kept.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const { db, now } = require("./db");
const { detectType, ALLOWED } = require("./filetype");
const audit = require("./audit");

db.exec(`
	CREATE TABLE IF NOT EXISTS evidence_archive (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		url TEXT NOT NULL UNIQUE,
		host TEXT NOT NULL,
		provider TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'archived', 'metadata', 'failed', 'unsupported')),
		title TEXT,
		author TEXT,
		media_url TEXT,
		stored_path TEXT,
		thumb_path TEXT,
		content_type TEXT,
		size INTEGER,
		sha256 TEXT,
		error TEXT,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_try INTEGER NOT NULL DEFAULT 0,
		source_status TEXT,
		source_checked_at INTEGER,
		source_dead_at INTEGER,
		first_seen_at INTEGER NOT NULL,
		archived_at INTEGER,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS evidence_links (
		evidence_id INTEGER NOT NULL REFERENCES evidence_archive(id) ON DELETE CASCADE,
		case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
		ref TEXT,
		author TEXT,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (evidence_id, case_id)
	);
	CREATE INDEX IF NOT EXISTS evidence_links_case ON evidence_links(case_id);
	CREATE INDEX IF NOT EXISTS evidence_archive_queue ON evidence_archive(status, next_try);
`);

const MAX_BYTES = (Number(process.env.EVIDENCE_MAX_MB) || 150) * 1024 * 1024;
const MAX_TOTAL = (Number(process.env.EVIDENCE_MAX_TOTAL_MB) || 2500) * 1024 * 1024;
const MAX_ATTEMPTS = 4;
const UA = "Mozilla/5.0 (compatible; SAHP-IA-Evidence/1.0; +https://sandyshores.dev)";
const URL_PATTERN = /https?:\/\/[^\s<>()"'`]+/gi;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav" };

// Pages we know how to read. provider → how the media is found.
const PROVIDERS = [
	{ key: "discord", hosts: ["cdn.discordapp.com", "media.discordapp.net"], mode: "direct" },
	{ key: "medal", hosts: ["medal.tv"], mode: "page" },
	{ key: "streamable", hosts: ["streamable.com"], mode: "page" },
	{ key: "imgur", hosts: ["imgur.com"], mode: "page" },
	{ key: "gyazo", hosts: ["gyazo.com"], mode: "page" },
	{ key: "outplayed", hosts: ["outplayed.tv"], mode: "page" },
	{ key: "lightshot", hosts: ["prnt.sc", "prntscr.com"], mode: "page" },
	{ key: "youtube", hosts: ["youtube.com", "youtu.be"], mode: "oembed" },
	{ key: "twitch", hosts: ["twitch.tv"], mode: "metadata" }
];
// Hosts media may be downloaded from (the pages above point at these CDNs).
const MEDIA_HOSTS = ["discordapp.com", "discordapp.net", "medal.tv", "streamable.com", "imgur.com", "gyazo.com", "outplayed.tv", "prnt.sc", "prntscr.com", "ytimg.com", "jtvnw.net", "twitch.tv"];

const hostMatches = (host, list) => list.some(d => host === d || host.endsWith(`.${d}`));

function providerFor(url) {
	let u;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return null;
	const host = u.hostname.toLowerCase();
	return { host, provider: PROVIDERS.find(p => hostMatches(host, p.hosts)) || null };
}

function cleanUrl(raw) {
	return String(raw || "").trim().replace(/[.,;:!?)\]>*_~|]+$/, "").slice(0, 1000);
}

// --- Collection -------------------------------------------------------------------------------

function register(url, caseId, ref, author) {
	const clean = cleanUrl(url);
	const info = providerFor(clean);
	if (!info || /discord(app)?\.com\/channels\//i.test(clean)) return;
	db.prepare(`INSERT INTO evidence_archive (url, host, provider, status, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(url) DO NOTHING`).run(clean, info.host, info.provider?.key || "other", info.provider ? "queued" : "unsupported", now(), now());
	const row = db.prepare("SELECT id FROM evidence_archive WHERE url = ?").get(clean);
	db.prepare("INSERT OR IGNORE INTO evidence_links (evidence_id, case_id, ref, author, created_at) VALUES (?, ?, ?, ?, ?)")
		.run(row.id, caseId, ref || null, author ? String(author).slice(0, 80) : null, now());
}

// Finds every link in a case's evidence list and in its linked ticket transcripts.
function collectForCase(caseId) {
	const row = db.prepare("SELECT id, evidence FROM cases WHERE id = ?").get(caseId);
	if (!row) return 0;
	const before = db.prepare("SELECT COUNT(*) AS n FROM evidence_links WHERE case_id = ?").get(caseId).n;
	let list = [];
	try {
		list = JSON.parse(row.evidence || "[]");
	} catch {
		list = [];
	}
	for (const e of list) if (e.url) register(e.url, caseId, e.ref, null);
	const messages = db.prepare(`SELECT t.ref, m.seq, m.author_name, m.content FROM case_tickets ct JOIN tickets t ON t.id = ct.ticket_id
		JOIN ticket_messages m ON m.ticket_id = t.id WHERE ct.case_id = ? AND m.content LIKE '%http%' ORDER BY t.id, m.seq`).all(caseId);
	for (const m of messages) for (const url of m.content.match(URL_PATTERN) || []) register(url, caseId, `${m.ref}#${m.seq}`, m.author_name);
	return db.prepare("SELECT COUNT(*) AS n FROM evidence_links WHERE case_id = ?").get(caseId).n - before;
}

function sweep() {
	let added = 0;
	for (const c of db.prepare("SELECT id FROM cases WHERE demo = 0 AND voided = 0").all()) added += collectForCase(c.id);
	if (added) console.log(`[evidence] ${added} new evidence link(s) found`);
	return added;
}

// --- Fetching ---------------------------------------------------------------------------------

async function safeFetch(url, allowed, { accept = "*/*", method = "GET" } = {}) {
	let current = url;
	for (let hop = 0; hop < 5; hop++) {
		const u = new URL(current);
		if (u.protocol !== "https:") u.protocol = "https:";
		if (!hostMatches(u.hostname.toLowerCase(), allowed)) throw Object.assign(new Error(`Host not allow-listed: ${u.hostname}`), { permanent: true });
		const response = await fetch(u, { method, redirect: "manual", headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(45000) });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const next = response.headers.get("location");
			if (!next) throw new Error("Redirect without location");
			current = new URL(next, u).toString();
			continue;
		}
		return { response, finalUrl: u.toString() };
	}
	throw new Error("Too many redirects");
}

async function readText(response, limit = 1024 * 1024) {
	const chunks = [];
	let total = 0;
	for await (const chunk of response.body || []) {
		total += chunk.length;
		chunks.push(Buffer.from(chunk));
		if (total > limit) break;
	}
	return Buffer.concat(chunks).toString("utf8");
}

const decode = s => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function metaTags(html) {
	const tags = {};
	for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
		const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
		const value = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
		if (key && value && !(key.toLowerCase() in tags)) tags[key.toLowerCase()] = decode(value);
	}
	const title = (html.match(/<title[^>]*>([^<]{1,300})<\/title>/i) || [])[1];
	return { tags, title: decode(title || "").trim() };
}

function mediaFromPage(html) {
	const { tags, title } = metaTags(html);
	const video = tags["og:video:secure_url"] || tags["og:video:url"] || tags["og:video"] || tags["twitter:player:stream"] || tags.contenturl;
	const image = tags["og:image:secure_url"] || tags["og:image"] || tags["twitter:image"];
	return {
		title: tags["og:title"] || tags["twitter:title"] || title || null,
		author: tags["author"] || tags["og:site_name"] || null,
		video: video && /^https:\/\//i.test(video) ? video : null,
		image: image && /^https:\/\//i.test(image) ? image : null
	};
}

function storageUsed() {
	return db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM evidence_archive WHERE stored_path IS NOT NULL").get().n;
}

// Streams a media file to disk, hashing as it goes. Returns null when the bytes are not an allowed type.
async function download(url) {
	const { response } = await safeFetch(url, MEDIA_HOSTS);
	if (response.status === 404 || response.status === 410) throw Object.assign(new Error(`Media returned ${response.status}`), { permanent: true, gone: true });
	if (!response.ok) throw new Error(`Media returned ${response.status}`);
	const declared = Number(response.headers.get("content-length") || 0);
	if (declared > MAX_BYTES) throw Object.assign(new Error(`File is ${(declared / 1048576).toFixed(0)} MB; the limit is ${MAX_BYTES / 1048576} MB`), { permanent: true });
	if (storageUsed() + declared > MAX_TOTAL) throw Object.assign(new Error("Evidence storage limit reached"), { permanent: true });
	const dir = path.join(config.DATA_DIR, "evidence");
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
	const hash = crypto.createHash("sha256");
	const out = fs.createWriteStream(tmp);
	let size = 0;
	let head = Buffer.alloc(0);
	try {
		for await (const chunk of response.body) {
			const buf = Buffer.from(chunk);
			size += buf.length;
			if (size > MAX_BYTES) throw Object.assign(new Error(`File exceeds ${MAX_BYTES / 1048576} MB`), { permanent: true });
			if (head.length < 64) head = Buffer.concat([head, buf.subarray(0, 64)]);
			hash.update(buf);
			if (!out.write(buf)) await new Promise(resolve => out.once("drain", resolve));
		}
		await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
		const type = detectType(head);
		if (!type || !ALLOWED.has(type)) {
			fs.rmSync(tmp, { force: true });
			return null;
		}
		const sha256 = hash.digest("hex");
		const name = `${sha256}.${EXT[type] || "bin"}`;
		const final = path.join(dir, name);
		if (fs.existsSync(final)) fs.rmSync(tmp, { force: true });
		else fs.renameSync(tmp, final);
		return { storedPath: path.join("evidence", name), contentType: type, size, sha256 };
	} catch (error) {
		out.destroy();
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

async function resolve(row) {
	const provider = PROVIDERS.find(p => p.key === row.provider);
	if (!provider) return { status: "unsupported", error: "Not a recognised clip or image host; link recorded only" };

	if (provider.mode === "direct") {
		// Discord CDN links are signed and expire after about a day; an expired link says nothing about deletion.
		const file = await download(row.url).catch(error => {
			if (error.gone) throw Object.assign(new Error("The Discord link expired before it could be archived"), { permanent: true });
			throw error;
		});
		return file ? { status: "archived", mediaUrl: row.url, ...file } : { status: "unsupported", error: "Not an image, video, or audio file" };
	}

	if (provider.mode === "oembed") {
		const { response } = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(row.url)}`, ["youtube.com"], { accept: "application/json" });
		if ([401, 403, 404].includes(response.status)) return { status: "failed", error: "Video is private or removed", gone: true };
		if (!response.ok) throw new Error(`YouTube returned ${response.status}`);
		const meta = JSON.parse(await readText(response, 64 * 1024));
		const thumb = meta.thumbnail_url ? await download(meta.thumbnail_url).catch(() => null) : null;
		return { status: "metadata", title: meta.title, author: meta.author_name, thumbPath: thumb?.storedPath || null, error: "YouTube videos are not downloaded; title, channel, and thumbnail are preserved" };
	}

	const { response } = await safeFetch(row.url, provider.hosts, { accept: "text/html,application/xhtml+xml" });
	if (response.status === 404 || response.status === 410) return { status: "failed", error: `Source returned ${response.status}: the clip may have been deleted`, gone: true };
	if (!response.ok) throw new Error(`Source returned ${response.status}`);
	const type = (response.headers.get("content-type") || "").toLowerCase();
	if (!type.includes("html")) {
		// Some share links point straight at the media.
		const file = await download(row.url);
		return file ? { status: "archived", mediaUrl: row.url, ...file } : { status: "unsupported", error: "Not an image, video, or audio file" };
	}
	const page = mediaFromPage(await readText(response));
	const thumb = page.image && page.video ? await download(page.image).catch(() => null) : null;
	if (provider.mode === "metadata") {
		const still = page.image ? await download(page.image).catch(() => null) : null;
		return { status: "metadata", title: page.title, author: page.author, thumbPath: still?.storedPath || null, error: "Twitch clips are not downloaded; title and preview image are preserved" };
	}
	for (const media of [page.video, page.image].filter(Boolean)) {
		if (!hostMatches(new URL(media).hostname.toLowerCase(), MEDIA_HOSTS)) continue;
		const file = await download(media);
		if (file) return { status: "archived", title: page.title, author: page.author, mediaUrl: media, thumbPath: thumb?.storedPath || null, ...file };
	}
	const blocked = [page.video, page.image].filter(Boolean).map(m => new URL(m).hostname).find(h => !hostMatches(h, MEDIA_HOSTS));
	return {
		status: "metadata",
		title: page.title,
		author: page.author,
		error: blocked ? `Media is served from ${blocked}, which is not allow-listed` : "The page did not expose a downloadable file"
	};
}

async function processOne(row) {
	db.prepare("UPDATE evidence_archive SET attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now(), row.id);
	try {
		const r = await resolve(row);
		db.prepare(`UPDATE evidence_archive SET status = ?, title = COALESCE(?, title), author = COALESCE(?, author), media_url = ?, stored_path = ?, thumb_path = ?,
			content_type = ?, size = ?, sha256 = ?, error = ?, archived_at = ?, source_status = ?, source_checked_at = ?, source_dead_at = COALESCE(source_dead_at, ?), updated_at = ? WHERE id = ?`)
			.run(r.status, r.title ? String(r.title).slice(0, 300) : null, r.author ? String(r.author).slice(0, 120) : null, r.mediaUrl || null, r.storedPath || null, r.thumbPath || null,
				r.contentType || null, r.size || null, r.sha256 || null, r.error || null, ["archived", "metadata"].includes(r.status) ? now() : null,
				r.gone ? "dead" : "alive", now(), r.gone ? now() : null, now(), row.id);
		if (r.status === "archived") audit.record(null, "evidence.archived", { type: "evidence", ref: String(row.id) }, { url: row.url, sha256: r.sha256, size: r.size });
	} catch (error) {
		const attempts = row.attempts + 1;
		const final = error.permanent || attempts >= MAX_ATTEMPTS;
		db.prepare("UPDATE evidence_archive SET status = ?, error = ?, next_try = ?, source_status = CASE WHEN ? THEN 'dead' ELSE source_status END, source_dead_at = CASE WHEN ? THEN COALESCE(source_dead_at, ?) ELSE source_dead_at END, updated_at = ? WHERE id = ?")
			.run(final ? "failed" : "queued", String(error.message).slice(0, 400), now() + 60000 * 5 ** attempts, error.gone ? 1 : 0, error.gone ? 1 : 0, now(), now(), row.id);
	}
}

// Re-checks archived sources. A source that disappears after it was reported is flagged on the case.
async function checkSource(row) {
	let alive = true;
	try {
		if (row.provider === "youtube") {
			const { response } = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(row.url)}`, ["youtube.com"]);
			alive = ![401, 403, 404].includes(response.status);
		} else if (row.provider === "discord") {
			return; // Discord CDN links expire by design; the archived copy is what matters.
		} else {
			const provider = PROVIDERS.find(p => p.key === row.provider);
			const { response } = await safeFetch(row.url, provider.hosts, { accept: "text/html" });
			if (response.status === 404 || response.status === 410) alive = false;
			else if (response.ok && (response.headers.get("content-type") || "").includes("html") && row.media_url) {
				const page = mediaFromPage(await readText(response));
				alive = Boolean(page.video || page.image);
			}
		}
	} catch {
		return; // Network trouble is not evidence of deletion.
	}
	db.prepare("UPDATE evidence_archive SET source_status = ?, source_checked_at = ?, source_dead_at = CASE WHEN ? = 'dead' THEN COALESCE(source_dead_at, ?) ELSE source_dead_at END WHERE id = ?")
		.run(alive ? "alive" : "dead", now(), alive ? "alive" : "dead", now(), row.id);
	if (!alive && row.source_status !== "dead") {
		const refs = db.prepare("SELECT c.ref FROM evidence_links l JOIN cases c ON c.id = l.case_id WHERE l.evidence_id = ?").all(row.id).map(r => r.ref);
		audit.record(null, "evidence.source_removed", { type: "evidence", ref: String(row.id) }, { url: row.url, cases: refs, archived: Boolean(row.stored_path) });
		console.log(`[evidence] source removed: ${row.url} (cases ${refs.join(", ")})`);
	}
}

// --- Worker -------------------------------------------------------------------------------------

let busy = false;
const timers = [];

async function work() {
	if (busy) return;
	busy = true;
	try {
		const row = db.prepare("SELECT * FROM evidence_archive WHERE status = 'queued' AND next_try <= ? ORDER BY id LIMIT 1").get(now());
		if (row) return await processOne(row);
		const due = db.prepare(`SELECT * FROM evidence_archive WHERE status IN ('archived', 'metadata') AND provider != 'discord'
			AND COALESCE(source_checked_at, 0) < ? ORDER BY COALESCE(source_checked_at, 0) LIMIT 1`).get(now() - 24 * 3600000);
		if (due) await checkSource(due);
	} finally {
		busy = false;
	}
}

function start() {
	try {
		sweep();
	} catch (error) {
		console.warn("[evidence] sweep failed:", error.message);
	}
	timers.push(setInterval(() => work().catch(e => console.warn("[evidence]", e.message)), 5000));
	timers.push(setInterval(() => { try { sweep(); } catch (e) { console.warn("[evidence] sweep failed:", e.message); } }, 10 * 60000));
	for (const t of timers) t.unref?.();
}

function stop() {
	while (timers.length) clearInterval(timers.pop());
}

// --- Views --------------------------------------------------------------------------------------

function toItem(r) {
	return {
		id: r.id,
		url: r.url,
		provider: r.provider,
		status: r.status,
		title: r.title,
		author: r.author,
		ref: r.ref,
		postedBy: r.link_author,
		contentType: r.content_type,
		size: r.size,
		sha256: r.sha256,
		hasFile: Boolean(r.stored_path),
		hasThumb: Boolean(r.thumb_path),
		error: r.error,
		archivedAt: r.archived_at,
		sourceStatus: r.source_status,
		sourceCheckedAt: r.source_checked_at,
		sourceDeadAt: r.source_dead_at
	};
}

function forCase(caseId) {
	return db.prepare(`SELECT e.*, l.ref, l.author AS link_author FROM evidence_links l JOIN evidence_archive e ON e.id = l.evidence_id
		WHERE l.case_id = ? ORDER BY e.id`).all(caseId).map(toItem);
}

// Re-queues a case's failed items and picks up new links right away.
function archiveNow(caseId, actor, ip) {
	const added = collectForCase(caseId);
	const retried = db.prepare(`UPDATE evidence_archive SET status = 'queued', attempts = 0, next_try = 0, updated_at = ?
		WHERE status = 'failed' AND id IN (SELECT evidence_id FROM evidence_links WHERE case_id = ?)`).run(now(), caseId).changes;
	const ref = db.prepare("SELECT ref FROM cases WHERE id = ?").get(caseId)?.ref;
	audit.record(actor, "evidence.archive_request", { type: "case", ref }, { added, retried }, ip);
	return { added, retried };
}

// Resolves a stored file for serving; the caller has already checked case access.
function fileFor(id, which = "file") {
	const row = db.prepare("SELECT * FROM evidence_archive WHERE id = ?").get(Number(id));
	const rel = which === "thumb" ? row?.thumb_path : row?.stored_path;
	if (!rel) return null;
	const root = path.resolve(config.DATA_DIR, "evidence");
	const full = path.resolve(config.DATA_DIR, rel);
	const inside = path.relative(root, full);
	if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !fs.existsSync(full)) return null;
	const fd = fs.openSync(full, "r");
	const head = Buffer.alloc(64);
	fs.readSync(fd, head, 0, 64, 0);
	fs.closeSync(fd);
	const type = detectType(head);
	if (!type || !ALLOWED.has(type)) return null;
	return { row, full, type };
}

function casesFor(id) {
	return db.prepare("SELECT c.* FROM evidence_links l JOIN cases c ON c.id = l.case_id WHERE l.evidence_id = ?").all(Number(id));
}

module.exports = { collectForCase, sweep, archiveNow, forCase, fileFor, casesFor, start, stop, work, processOne, checkSource, mediaFromPage, providerFor };
