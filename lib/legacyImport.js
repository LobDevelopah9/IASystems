// Imports past investigations (from the Trello board and the Google Doc reports) as closed, read-only case records.
// Idempotent: records are keyed by their source ID, so re-running updates existing imports (e.g. once more
// reports become readable) instead of duplicating them.
const { db, now, json, getSetting, setSetting } = require("./db");
const { TAGS, FINDINGS, punishmentByKey } = require("./policy");
const cases = require("./cases");
const audit = require("./audit");

const SOURCE = "trello";
const STATUSES = new Set(["closed", "under_investigation", "marked_for_review"]);

const str = (v, max = 20000) => (typeof v === "string" ? v : v == null ? "" : String(v)).replace(/\u0000/g, "").trim().slice(0, max);
const httpError = (status, message) => Object.assign(new Error(message), { status });

function parseDate(text) {
	const t = Date.parse(str(text, 60));
	return Number.isNaN(t) ? null : t;
}

// Maps free-text punishments ("X1 Blackmark, 48H Suspension, 7 day FTO") to category keys for search and stats.
function punishmentKeysFrom(text) {
	const t = str(text, 1000).toLowerCase();
	const keys = [];
	const add = k => { if (punishmentByKey(k) && !keys.includes(k)) keys.push(k); };
	if (/black\s*-?\s*mark|\bbm\b/.test(t)) add("black_mark");
	if (/suspen|\bsusp\b/.test(t)) add("suspension");
	if (/\bfto\b|field training/.test(t)) add("fto");
	if (/blacklist/.test(t)) add("blacklist");
	if (/terminat/.test(t)) add("termination");
	if (/demot/.test(t)) add("demotion");
	if (/ia watch|internal affairs watch/.test(t)) add("ia_watch");
	if (/administrative watch|\ba\/w\b|admin watch/.test(t)) add("admin_watch");
	if (/infraction/.test(t)) add("infraction");
	if (/verbal/.test(t)) add("verbal_warning");
	if (!keys.length && /no action|none|n\/a|dismissed without/.test(t)) add("no_action");
	return keys;
}

function findingFrom(supports) {
	const s = str(supports, 40).toUpperCase();
	if (s.startsWith("YES")) return "sustained";
	if (s.startsWith("PARTIAL")) return "partially_sustained";
	if (s.startsWith("NO")) return "not_sustained";
	return null;
}

function normalize(record) {
	const r = record || {};
	const legacyId = str(r.legacyId, 64);
	if (!/^[A-Za-z0-9_-]{6,64}$/.test(legacyId)) throw httpError(400, "Every record needs a valid legacyId");
	const subject = r.subject || {};
	const report = r.report || {};
	const status = STATUSES.has(r.status) ? r.status : "closed";
	return {
		legacyId,
		caseNumber: Number.isInteger(r.caseNumber) && r.caseNumber > 0 && r.caseNumber < 100000 ? r.caseNumber : null,
		title: str(r.title, 140) || "Imported investigation",
		status,
		classification: str(r.classification, 80) || "Standard Trooper Report",
		violations: (Array.isArray(r.violations) ? r.violations : []).map(v => str(v, 80)).filter(Boolean).slice(0, 20),
		tags: (Array.isArray(r.tags) ? r.tags : []).filter(k => TAGS.some(t => t.key === k)),
		subject: {
			roblox: str(subject.roblox, 60).replace(/[^A-Za-z0-9_]/g, ""),
			discord: str(subject.discord, 60),
			rank: str(subject.rank, 30),
			callsign: str(subject.callsign, 20)
		},
		accuser: {
			name: str(r.accuser?.name, 120),
			discord: str(r.accuser?.discord, 120),
			roblox: str(r.accuser?.roblox, 120)
		},
		investigators: str(r.investigators, 200),
		processedBy: str(r.processedBy, 120),
		punishmentText: str(r.punishmentText, 1000),
		punishmentNotes: str(r.punishmentNotes, 1000),
		supports: str(r.supports, 40),
		reportDate: str(r.reportDate, 40),
		closedDate: str(r.closedDate, 40),
		createdAt: Number.isFinite(r.createdAt) ? r.createdAt : null,
		docUrl: /^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+/.test(str(r.docUrl, 300)) ? str(r.docUrl, 300) : null,
		report: {
			ticketDetails: str(report.ticketDetails, 60000),
			statement: str(report.statement, 60000),
			conclusion: str(report.conclusion, 30000),
			interviewLocation: str(report.interviewLocation, 200),
			interviewPresent: str(report.interviewPresent, 500),
			interviewNotes: str(report.interviewNotes, 5000),
			extra: str(report.extra, 60000),
			evidence: (Array.isArray(report.evidence) ? report.evidence : []).slice(0, 60).map(e => ({
				label: str(e?.label, 120) || "Evidence",
				url: /^https?:\/\//i.test(str(e?.url, 500)) ? str(e.url, 500) : ""
			})).filter(e => e.url)
		}
	};
}

function upsertPersonnel(s, seenAt) {
	if (!s.roblox) return null;
	const existing = db.prepare("SELECT * FROM personnel WHERE lower(roblox_username) = lower(?)").get(s.roblox);
	if (existing) {
		// Rank and callsign follow the most recent record for this member.
		const newer = !existing.updated_at || (seenAt || 0) >= (existing.updated_at || 0) || !existing.rank;
		db.prepare(`UPDATE personnel SET rank = CASE WHEN ? THEN COALESCE(NULLIF(?, ''), rank) ELSE COALESCE(rank, NULLIF(?, '')) END,
			callsign = CASE WHEN ? THEN COALESCE(NULLIF(?, ''), callsign) ELSE COALESCE(callsign, NULLIF(?, '')) END,
			discord_username = COALESCE(discord_username, NULLIF(?, '')) WHERE id = ?`)
			.run(newer ? 1 : 0, s.rank, s.rank, newer ? 1 : 0, s.callsign, s.callsign, s.discord, existing.id);
		return existing.id;
	}
	return db.prepare("INSERT INTO personnel (name, roblox_username, discord_username, rank, callsign, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(s.roblox, s.roblox, s.discord || null, s.rank || null, s.callsign || null, now(), seenAt || now()).lastInsertRowid;
}

// Chooses the case reference: the original number, with -B, -C... when another record already holds it
// (one investigation that covered several accused, or a number already used in the portal).
function chooseRef(number, legacyId) {
	if (!number) return null;
	const base = String(number).padStart(4, "0");
	for (const suffix of ["", "-B", "-C", "-D", "-E", "-F", "-G", "-H"]) {
		const ref = base + suffix;
		const holder = db.prepare("SELECT legacy_id FROM cases WHERE ref = ?").get(ref);
		if (!holder || holder.legacy_id === legacyId) return ref;
	}
	return `${base}-${legacyId.slice(-4)}`;
}

function run(records, actor, { dryRun = false } = {}) {
	if (!Array.isArray(records) || !records.length) throw httpError(400, "No records to import");
	if (records.length > 5000) throw httpError(400, "Too many records in one import");
	const clean = records.map(normalize);
	const summary = { total: clean.length, created: 0, updated: 0, withReport: 0, conflicts: [], personnel: 0 };

	const apply = db.transaction(() => {
		const personnelBefore = db.prepare("SELECT COUNT(*) AS n FROM personnel").get().n;
		for (const r of clean) {
			const existing = db.prepare("SELECT * FROM cases WHERE legacy_source = ? AND legacy_id = ?").get(SOURCE, r.legacyId);
			const seenAt = parseDate(r.closedDate) || parseDate(r.reportDate) || r.createdAt || now();
			const subjectId = upsertPersonnel(r.subject, seenAt);
			const keys = punishmentKeysFrom(r.punishmentText);
			const finding = findingFrom(r.supports) || (keys.length && !keys.includes("no_action") ? "sustained" : null);
			const hasReport = Boolean(r.report.ticketDetails || r.report.conclusion);
			if (hasReport) summary.withReport++;
			const fields = {
				title: r.title,
				classification: r.classification,
				violations: JSON.stringify(r.violations),
				tags: JSON.stringify(r.tags),
				subject_personnel_id: subjectId,
				reporter_name: r.accuser.name || r.accuser.roblox || null,
				reporter_username: r.accuser.discord || null,
				reporter_roblox: r.accuser.roblox || null,
				narrative_summary: r.report.ticketDetails,
				narrative_interview: r.report.statement,
				conclusion: r.report.conclusion,
				evidence: JSON.stringify(r.report.evidence),
				interview_location: r.report.interviewLocation || "Ticket",
				interview_present: r.report.interviewPresent,
				interview_notes: r.report.interviewNotes,
				final_finding: finding,
				final_punishment: keys.length ? keys.join(",") : null,
				final_punishment_detail: r.punishmentText.slice(0, 500),
				punishment_text: r.punishmentText,
				punishment_notes: r.punishmentNotes,
				legacy_doc_url: r.docUrl,
				legacy_investigators: r.investigators || null,
				legacy_processed_by: r.processedBy || null,
				legacy_report_date: r.reportDate || null,
				legacy_closed_date: r.closedDate || null,
				legacy_extra: r.report.extra
			};
			if (existing) {
				// Never overwrite report text an investigator has since edited, and never blank out imported text.
				if (existing.narrative_human_edited || !hasReport) {
					for (const k of ["narrative_summary", "narrative_interview", "conclusion", "evidence", "interview_present", "interview_notes", "legacy_extra"]) delete fields[k];
				}
				const cols = Object.keys(fields);
				db.prepare(`UPDATE cases SET ${cols.map(c => `${c} = @${c}`).join(", ")}, updated_at = @at WHERE id = @id`).run({ ...fields, at: now(), id: existing.id });
				cases.indexCase(existing.id);
				summary.updated++;
				continue;
			}
			const ref = chooseRef(r.caseNumber, r.legacyId);
			if (ref && ref !== String(r.caseNumber).padStart(4, "0")) summary.conflicts.push({ caseNumber: r.caseNumber, ref, title: r.title });
			const createdAt = parseDate(r.reportDate) || r.createdAt || seenAt;
			const closedAt = r.status === "closed" ? (parseDate(r.closedDate) || seenAt) : null;
			const id = db.prepare(`INSERT INTO cases (ref, case_number, status, kind, title, created_by, created_via, created_at, updated_at, closed_at, approved_at,
				ai_state, legacy_source, legacy_id) VALUES (?, ?, ?, 'misconduct', ?, ?, 'import', ?, ?, ?, ?, 'none', ?, ?)`)
				.run(ref || `L-${r.legacyId.slice(-6)}`, r.caseNumber, r.status, r.title, actor?.discord_id || null, createdAt, now(), closedAt, closedAt, SOURCE, r.legacyId).lastInsertRowid;
			const cols = Object.keys(fields);
			db.prepare(`UPDATE cases SET ${cols.map(c => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...fields, id });
			cases.indexCase(id);
			summary.created++;
		}
		summary.personnel = db.prepare("SELECT COUNT(*) AS n FROM personnel").get().n - personnelBefore;
		// New portal cases continue after the last imported number in the unbroken sequence (isolated typos such as a
		// stray #0653 after #0645 are ignored; the numbering skips any number that is already taken anyway).
		const numbers = db.prepare("SELECT DISTINCT case_number AS n FROM cases WHERE legacy_source IS NOT NULL AND case_number IS NOT NULL ORDER BY n").all().map(r => r.n);
		let sequenceEnd = 0;
		numbers.forEach((n, i) => { if (i > 0 && n - numbers[i - 1] <= 3) sequenceEnd = n; });
		if (sequenceEnd + 1 > (Number(getSetting("next_case_number", 0)) || 0)) setSetting("next_case_number", sequenceEnd + 1, actor?.discord_id);
		if (dryRun) throw Object.assign(new Error("dry run"), { dryRun: true });
	});

	try {
		apply();
	} catch (error) {
		if (!error.dryRun) throw error;
		return { ...summary, dryRun: true };
	}
	audit.record(actor, "system.legacy_import", { type: "system", ref: SOURCE }, { created: summary.created, updated: summary.updated, withReport: summary.withReport, conflicts: summary.conflicts.length });
	return summary;
}

module.exports = { run, punishmentKeysFrom, findingFrom, normalize };
