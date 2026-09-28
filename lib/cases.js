const crypto = require("crypto");
const { db, now, json } = require("./db");
const { can, effectiveRole, isOwner } = require("./permissions");
const { punishmentByKey, punishmentKeys, punishmentLabel, findingSupports, nextCaseNumber, FINDINGS } = require("./policy");
const audit = require("./audit");
const { OWNER_DISCORD_IDS, EXPORT_DISCORD_IDS } = require("./config");

const STATUS_LABELS = {
	marked_for_review: "Marked for Review",
	under_investigation: "Under Investigation",
	approved: "Approved",
	appealed: "Appealed",
	closed: "Closed"
};

// from -> to -> capability required. "sign" means the move only happens through a supervisor signature.
const TRANSITIONS = {
	marked_for_review: { under_investigation: "case.edit", approved: "sign" },
	under_investigation: { marked_for_review: "case.edit", approved: "sign" },
	approved: { closed: "case.decide", appealed: "case.decide", under_investigation: "case.decide" },
	appealed: { under_investigation: "case.decide", approved: "sign", closed: "case.decide" },
	closed: { appealed: "case.reopen_closed" }
};

const EDITABLE = {
	title: { cap: "case.edit", type: "text", max: 140 },
	kind: { cap: "case.edit", type: "enum", values: ["misconduct", "ops"] },
	classification: { cap: "case.edit", type: "text", max: 80 },
	violations: { cap: "case.edit", type: "list" },
	reporter_roblox: { cap: "case.edit", type: "text", max: 60 },
	conclusion: { cap: "case.edit", type: "text", max: 20000 },
	evidence: { cap: "case.edit", type: "evidence" },
	interview_location: { cap: "case.edit", type: "text", max: 120 },
	interview_present: { cap: "case.edit", type: "text", max: 500 },
	interview_notes: { cap: "case.edit", type: "text", max: 5000 },
	incident_at: { cap: "case.edit", type: "text", max: 120 },
	incident_location: { cap: "case.edit", type: "text", max: 200 },
	subject_personnel_id: { cap: "case.edit", type: "personnel" },
	narrative_summary: { cap: "case.edit", type: "text", max: 20000 },
	narrative_interview: { cap: "case.edit", type: "text", max: 20000 },
	narrative_location: { cap: "case.edit", type: "text", max: 5000 },
	narrative_timeline: { cap: "case.edit", type: "timeline" },
	final_finding: { cap: "case.decide", type: "finding" },
	final_punishment: { cap: "case.decide", type: "punishment" },
	final_punishment_detail: { cap: "case.decide", type: "text", max: 500 },
	final_appealable: { cap: "case.decide", type: "bool" },
	subject_notice: { cap: "case.decide", type: "text", max: 4000 }
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

function formatRef(number) {
	return String(number).padStart(4, "0");
}

// Accepts "0644", "#0644", "644", or "Case #0644".
function normalizeRef(ref) {
	const digits = String(ref || "").replace(/^\s*(case)?\s*#?\s*/i, "").trim();
	return /^\d+$/.test(digits) ? formatRef(Number(digits)) : digits;
}

function getCase(ref) {
	return db.prepare("SELECT * FROM cases WHERE ref = ?").get(normalizeRef(ref));
}

function requireCase(ref) {
	const row = getCase(ref);
	if (!row) throw httpError(404, "Case not found");
	return row;
}

function personnel(id) {
	return id ? db.prepare("SELECT * FROM personnel WHERE id = ?").get(id) : null;
}

function userName(id) {
	if (!id) return null;
	const user = db.prepare("SELECT display_name, username, callsign FROM users WHERE discord_id = ?").get(id);
	return user ? (user.display_name || user.username) : null;
}

function trueRelation(user, row) {
	const subject = personnel(row.subject_personnel_id);
	return {
		isSubject: Boolean(user && subject?.discord_id && subject.discord_id === user.discord_id),
		isReporter: Boolean(user && row.reporter_id && row.reporter_id === user.discord_id)
	};
}

function userAvatar(id) {
	if (!id) return null;
	const url = db.prepare("SELECT avatar FROM users WHERE discord_id = ?").get(id)?.avatar;
	return /^https:\/\/cdn\.discordapp\.com\//.test(String(url || "")) ? url : null;
}

function relation(user, row) {
	const rel = trueRelation(user, row);
	// Owners are never treated as subject or reporter for access purposes.
	if (isOwner(user)) return { isSubject: false, isReporter: false, override: rel.isSubject || rel.isReporter };
	return { ...rel, override: false };
}

function contentHash(row) {
	const fields = [
		"title", "kind", "classification", "violations", "subject_personnel_id", "incident_at", "incident_location",
		"narrative_summary", "narrative_timeline", "narrative_interview", "narrative_location",
		"conclusion", "evidence", "interview_location", "interview_present", "interview_notes",
		"final_finding", "final_punishment", "final_punishment_detail", "final_appealable", "subject_notice"
	];
	const canonical = JSON.stringify(fields.map(field => [field, row[field] ?? null]));
	return crypto.createHash("sha256").update(canonical).digest("hex");
}

function latestSignature(caseId) {
	return db.prepare("SELECT * FROM signatures WHERE case_id = ? ORDER BY id DESC LIMIT 1").get(caseId);
}

function signatureState(row) {
	const sig = latestSignature(row.id);
	if (!sig) return "none";
	return sig.content_hash === contentHash(row) ? "valid" : "stale";
}

// --- Access decisions -------------------------------------------------------

function accessLevel(user, row) {
	const rel = relation(user, row);
	// A member who is the subject of a case only ever gets the member view, whatever their IA role.
	if (rel.isSubject) {
		return ["approved", "appealed", "closed"].includes(row.status) && can(user, "self.cases") ? "subject" : "none";
	}
	if (can(user, "case.view")) return "ia";
	return "none";
}

function recusal(user, row) {
	const rel = relation(user, row);
	if (rel.isSubject) return "You are the subject of this case.";
	if (rel.isReporter) return "You filed the report for this case.";
	return null;
}

function allowedTransitions(user, row) {
	if (accessLevel(user, row) !== "ia" || recusal(user, row)) return [];
	const moves = TRANSITIONS[row.status] || {};
	return Object.entries(moves)
		.filter(([to, cap]) => cap === "sign" ? can(user, "case.decide") : can(user, cap))
		.filter(([to]) => !(to === "appealed" && !row.final_appealable && !can(user, "case.reopen_closed")))
		.map(([to, cap]) => ({ to, label: STATUS_LABELS[to], requiresSignature: cap === "sign" }));
}

function casePermissions(user, row) {
	const recused = recusal(user, row);
	const locked = row.status === "closed";
	return {
		recused,
		locked,
		canEdit: !recused && !locked && can(user, "case.edit") && (row.status !== "approved" || can(user, "case.decide")),
		canDecide: !recused && !locked && can(user, "case.decide"),
		canSign: !recused && !locked && can(user, "case.decide") && ["marked_for_review", "under_investigation", "appealed"].includes(row.status),
		canAssign: !recused && can(user, "case.assign"),
		canNote: !recused && can(user, "case.note"),
		canRedraft: !recused && !locked && can(user, "case.redraft") && row.status !== "approved",
		canViewIdentity: can(user, "case.view_identity") && !relation(user, row).isSubject,
		canViewHistory: can(user, "audit.view"),
		ownerOverride: relation(user, row).override,
		canExport: EXPORT_DISCORD_IDS.includes(user?.discord_id),
		canDelete: OWNER_DISCORD_IDS.includes(user?.discord_id) && !relation(user, row).isSubject && !latestSignature(row.id),
		transitions: allowedTransitions(user, row)
	};
}

// --- Serialization ----------------------------------------------------------

function reporterView(row, user) {
	const base = { anonymous: Boolean(row.anonymous), name: row.reporter_name, id: row.reporter_id, username: row.reporter_username, roblox: row.reporter_roblox };
	// IA staff always see the reporter; only the accused (who never reaches this view) is kept from it.
	if (!row.anonymous || (can(user, "case.view_identity") && !relation(user, row).isSubject)) return { ...base, revealed: true };
	return { anonymous: true, name: null, id: null, username: null, roblox: null, revealed: false };
}

function subjectView(row) {
	const p = personnel(row.subject_personnel_id);
	return p ? {
		id: p.id, name: p.name, callsign: p.callsign, discordId: p.discord_id, rank: p.rank,
		roblox: p.roblox_username, discordUsername: p.discord_username, department: p.department || "SAHP"
	} : null;
}

function ticketsFor(caseId, user) {
	const identity = can(user, "case.view_identity");
	return db.prepare(`
		SELECT t.* FROM case_tickets ct JOIN tickets t ON t.id = ct.ticket_id
		WHERE ct.case_id = ? ORDER BY t.opened_at
	`).all(caseId).map(t => ({
		ref: t.ref,
		type: t.type,
		status: t.status,
		anonymous: Boolean(t.anonymous),
		opener: t.anonymous && !identity ? null : t.opener_name,
		openedAt: t.opened_at,
		closedAt: t.closed_at,
		messageCount: t.message_count
	}));
}

// Cases that share a ticket, e.g. one report naming two accused troopers.
function relatedCases(row, user) {
	return db.prepare(`SELECT DISTINCT c.* FROM case_tickets a JOIN case_tickets b ON a.ticket_id = b.ticket_id AND b.case_id <> a.case_id
		JOIN cases c ON c.id = b.case_id WHERE a.case_id = ?`).all(row.id)
		.filter(c => accessLevel(user, c) === "ia")
		.map(c => ({ ref: c.ref, title: c.title, status: c.status, subject: personnel(c.subject_personnel_id)?.name || null }));
}

function investigatorNames(row) {
	const names = [];
	if (row.assigned_agent_id) names.push(userName(row.assigned_agent_id));
	return names.filter(Boolean);
}

function toSignature(sig, row) {
	return {
		id: sig.id,
		signerName: sig.signer_name,
		signerTitle: sig.signer_title,
		finding: sig.finding,
		punishment: sig.punishment,
		punishmentLabel: punishmentLabel(sig.punishment, sig.punishment_detail),
		punishmentDetail: sig.punishment_detail,
		appealable: Boolean(sig.appealable),
		statement: sig.statement,
		signedAt: sig.signed_at,
		hash: sig.content_hash,
		stale: sig.content_hash !== contentHash(row)
	};
}

function serializeCase(row, user, { asSubject = false } = {}) {
	const level = asSubject && trueRelation(user, row).isSubject ? "subject" : accessLevel(user, row);
	if (level === "none") throw httpError(404, "Case not found");
	const latest = latestSignature(row.id);

	if (level === "subject") {
		const appeal = db.prepare("SELECT status, created_at FROM appeals WHERE case_id = ? ORDER BY id DESC LIMIT 1").get(row.id);
		return {
			view: "subject",
			ref: row.ref,
			title: row.title,
			status: row.status,
			statusLabel: STATUS_LABELS[row.status],
			incidentAt: row.incident_at,
			violations: json(row.violations, []),
			finding: latest?.finding || row.final_finding,
			punishment: punishmentLabel(latest?.punishment || row.final_punishment),
			punishmentDetail: latest?.punishment_detail || row.final_punishment_detail,
			appealable: Boolean(latest ? latest.appealable : row.final_appealable),
			notice: row.subject_notice,
			signedBy: latest ? { name: latest.signer_name, title: latest.signer_title, at: latest.signed_at } : null,
			appeal: appeal || null,
			canAppeal: Boolean(latest?.appealable) && ["approved", "closed"].includes(row.status) && !appeal
		};
	}

	const ai = db.prepare("SELECT * FROM ai_decisions WHERE case_id = ? ORDER BY id DESC LIMIT 1").get(row.id);
	return {
		view: "ia",
		ref: row.ref,
		title: row.title,
		kind: row.kind,
		classification: row.classification,
		violations: json(row.violations, []),
		status: row.status,
		statusLabel: STATUS_LABELS[row.status],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		approvedAt: row.approved_at,
		closedAt: row.closed_at,
		createdVia: row.created_via,
		createdBy: userName(row.created_by),
		incidentAt: row.incident_at,
		incidentLocation: row.incident_location,
		subject: subjectView(row),
		reporter: reporterView(row, user),
		assignedAgent: row.assigned_agent_id ? { id: row.assigned_agent_id, name: userName(row.assigned_agent_id), avatar: userAvatar(row.assigned_agent_id) } : null,
		investigators: investigatorNames(row),
		narrative: {
			summary: row.narrative_summary,
			timeline: json(row.narrative_timeline, []),
			excerpts: json(row.narrative_excerpts, []),
			interview: row.narrative_interview,
			location: row.narrative_location,
			sources: json(row.narrative_sources, {}),
			humanEdited: Boolean(row.narrative_human_edited)
		},
		report: {
			conclusion: row.conclusion,
			evidence: json(row.evidence, []),
			interviewLocation: row.interview_location,
			interviewPresent: row.interview_present,
			interviewNotes: row.interview_notes,
			evidenceSupports: findingSupports(latest?.finding || row.final_finding),
			punishmentsIssued: latest ? punishmentLabel(latest.punishment, latest.punishment_detail) : null,
			processedBy: latest?.signer_name || null
		},
		ai: {
			state: row.ai_state,
			error: row.ai_error,
			pendingDraft: Boolean(row.pending_draft_id),
			decision: ai ? {
				finding: ai.finding,
				punishment: ai.punishment,
				punishmentKeys: punishmentKeys(ai.punishment),
				punishmentLabel: punishmentLabel(ai.punishment),
				punishmentDetail: ai.punishment_detail,
				appealable: Boolean(ai.appealable),
				rationale: ai.rationale,
				signature: ai.signature,
				model: ai.model,
				signedAt: ai.signed_at,
				hash: ai.content_hash
			} : null
		},
		final: {
			finding: row.final_finding,
			punishment: row.final_punishment,
			punishmentKeys: punishmentKeys(row.final_punishment),
			punishmentLabel: punishmentLabel(row.final_punishment),
			punishmentDetail: row.final_punishment_detail,
			appealable: row.final_appealable == null ? null : Boolean(row.final_appealable),
			notice: row.subject_notice
		},
		signatures: db.prepare("SELECT * FROM signatures WHERE case_id = ? ORDER BY id DESC").all(row.id).map(sig => toSignature(sig, row)),
		signatureState: signatureState(row),
		tickets: ticketsFor(row.id, user),
		related: relatedCases(row, user),
		notes: db.prepare("SELECT id, author_name, body, created_at FROM case_notes WHERE case_id = ? ORDER BY id").all(row.id),
		appeals: db.prepare("SELECT id, reason, status, created_at, resolved_at FROM appeals WHERE case_id = ? ORDER BY id DESC").all(row.id),
		permissions: casePermissions(user, row),
		demo: Boolean(row.demo)
	};
}

function card(row, user) {
	const subject = subjectView(row);
	const reporter = reporterView(row, user);
	const ai = db.prepare("SELECT punishment, finding FROM ai_decisions WHERE case_id = ? ORDER BY id DESC LIMIT 1").get(row.id);
	return {
		ref: row.ref,
		title: row.title,
		status: row.status,
		kind: row.kind,
		violations: json(row.violations, []),
		subject: subject ? { name: subject.name, callsign: subject.callsign, roblox: subject.roblox } : null,
		reporter: reporter.revealed ? reporter.name : null,
		anonymous: Boolean(row.anonymous),
		agent: row.assigned_agent_id ? userName(row.assigned_agent_id) : null,
		agentAvatar: userAvatar(row.assigned_agent_id),
		aiState: row.ai_state,
		signatureState: signatureState(row),
		punishment: punishmentLabel(row.final_punishment),
		aiPunishment: ai ? { label: punishmentLabel(ai.punishment), finding: ai.finding } : null,
		ticketCount: db.prepare("SELECT COUNT(*) AS n FROM case_tickets WHERE case_id = ?").get(row.id).n,
		appealPending: Boolean(db.prepare("SELECT 1 FROM appeals WHERE case_id = ? AND status = 'pending'").get(row.id)),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		incidentAt: row.incident_at,
		demo: Boolean(row.demo),
		transitions: allowedTransitions(user, row).map(t => t.to)
	};
}

// --- Search -------------------------------------------------------------------

function indexCase(caseId) {
	const row = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId);
	db.prepare("DELETE FROM cases_fts WHERE case_id = ?").run(caseId);
	if (!row) return;
	const subject = personnel(row.subject_personnel_id);
	const timeline = json(row.narrative_timeline, []).map(item => `${item.when || ""} ${item.event || ""}`).join(" ");
	db.prepare(`INSERT INTO cases_fts (case_id, ref, title, subject, reporter, location, body) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
		row.id,
		`${row.ref} ${Number(row.ref) || ""} ${row.classification} ${json(row.violations, []).join(" ")}`,
		row.title,
		subject ? `${subject.name} ${subject.callsign || ""} ${subject.roblox_username || ""} ${subject.discord_username || ""}` : "",
		`${row.reporter_name || ""} ${row.reporter_username || ""} ${row.reporter_roblox || ""}`,
		`${row.incident_location} ${row.narrative_location}`,
		`${row.narrative_summary} ${row.narrative_interview} ${row.conclusion} ${timeline}`
	);
}

function ftsQuery(text) {
	const tokens = String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
	return tokens.slice(0, 8).map(token => `"${token}"*`).join(" ");
}

function searchCases(user, filters = {}) {
	if (!can(user, "case.view")) throw httpError(403, "Not permitted");
	const where = [];
	const params = {};
	const match = ftsQuery(filters.q);

	if (match) {
		where.push("c.id IN (SELECT case_id FROM cases_fts WHERE cases_fts MATCH @match)");
		params.match = match;
	}
	const statuses = [].concat(filters.status || []).flatMap(s => String(s).split(",")).filter(s => STATUS_LABELS[s]);
	if (statuses.length) {
		where.push(`c.status IN (${statuses.map((_, i) => `@s${i}`).join(",")})`);
		statuses.forEach((s, i) => { params[`s${i}`] = s; });
	}
	if (filters.kind === "misconduct" || filters.kind === "ops") {
		where.push("c.kind = @kind");
		params.kind = filters.kind;
	}
	if (filters.agent) {
		where.push(filters.agent === "unassigned" ? "c.assigned_agent_id IS NULL" : "c.assigned_agent_id = @agent");
		params.agent = filters.agent === "me" ? user.discord_id : filters.agent;
	}
	if (filters.subject) {
		where.push("c.subject_personnel_id IN (SELECT id FROM personnel WHERE name LIKE @subject OR callsign LIKE @subject OR roblox_username LIKE @subject OR discord_username LIKE @subject)");
		params.subject = `%${filters.subject}%`;
	}
	if (filters.reporter) {
		where.push("(c.reporter_name LIKE @reporter OR c.reporter_username LIKE @reporter OR c.reporter_roblox LIKE @reporter)");
		params.reporter = `%${filters.reporter}%`;
	}
	if (filters.anonymous === "1") where.push("c.anonymous = 1");
	const from = Date.parse(filters.from || "");
	const to = Date.parse(filters.to || "");
	if (!Number.isNaN(from)) { where.push("c.created_at >= @from"); params.from = from; }
	if (!Number.isNaN(to)) { where.push("c.created_at < @to"); params.to = to + 86400000; }

	// Cases where the viewer is the subject never appear on their IA board.
	where.push("NOT EXISTS (SELECT 1 FROM personnel p WHERE p.id = c.subject_personnel_id AND p.discord_id = @me)");
	params.me = isOwner(user) ? "" : user.discord_id;

	const sql = `SELECT c.* FROM cases c ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.updated_at DESC LIMIT 500`;
	return db.prepare(sql).all(params).map(row => card(row, user));
}

// --- Mutations ----------------------------------------------------------------

function touch(caseId) {
	db.prepare("UPDATE cases SET updated_at = ? WHERE id = ?").run(now(), caseId);
	indexCase(caseId);
}

const createCase = db.transaction((data, actor, via = "portal") => {
	const at = now();
	const info = db.prepare(`
		INSERT INTO cases (status, kind, title, classification, violations, subject_personnel_id, reporter_id, reporter_name,
			reporter_username, reporter_roblox, anonymous, incident_at, incident_location, assigned_agent_id, created_by, created_via,
			created_at, updated_at, narrative_summary, evidence, interview_present, ai_state, demo)
		VALUES (@status, @kind, @title, @classification, @violations, @subject, @reporterId, @reporterName,
			@reporterUsername, @reporterRoblox, @anonymous, @incidentAt, @incidentLocation, @agent, @createdBy, @via,
			@at, @at, @summary, @evidence, @present, @aiState, @demo)
	`).run({
		status: data.status || "marked_for_review",
		kind: data.kind === "ops" ? "ops" : "misconduct",
		title: String(data.title || "Untitled case").slice(0, 140),
		classification: String(data.classification || (data.kind === "ops" ? "OPS / System Report" : data.anonymous ? "Anonymous Trooper Report" : "Standard Trooper Report")).slice(0, 80),
		violations: JSON.stringify(cleanList(data.violations || [])),
		reporterUsername: data.reporterUsername || null,
		reporterRoblox: data.reporterRoblox || null,
		evidence: JSON.stringify(cleanEvidence(data.evidence || [])),
		present: String(data.interviewPresent || "").slice(0, 500),
		subject: data.subjectPersonnelId || null,
		reporterId: data.reporterId || null,
		reporterName: data.reporterName || null,
		anonymous: data.anonymous ? 1 : 0,
		incidentAt: String(data.incidentAt || "").slice(0, 120),
		incidentLocation: String(data.incidentLocation || "").slice(0, 200),
		agent: data.assignedAgentId || null,
		createdBy: actor?.discord_id || null,
		via,
		at,
		summary: String(data.summary || ""),
		aiState: data.draftWithAi ? "queued" : "none",
		demo: data.demo ? 1 : 0
	});
	const id = info.lastInsertRowid;
	// Demo cases use a 9000 range so they never consume real case numbers.
	const number = data.demo ? 9000 + Number(id) : nextCaseNumber();
	const ref = formatRef(number);
	db.prepare("UPDATE cases SET ref = ?, case_number = ? WHERE id = ?").run(ref, number, id);
	for (const ticketId of data.ticketIds || []) {
		db.prepare("INSERT OR IGNORE INTO case_tickets (case_id, ticket_id, added_by, added_at) VALUES (?, ?, ?, ?)").run(id, ticketId, actor?.discord_id || null, at);
	}
	if (data.draftWithAi) enqueueDraft(id);
	indexCase(id);
	audit.record(actor, "case.create", { type: "case", ref }, { via, tickets: (data.ticketIds || []).length, ai: Boolean(data.draftWithAi) });
	return db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
});

function enqueueDraft(caseId) {
	const existing = db.prepare("SELECT id FROM jobs WHERE kind = 'draft_case' AND status IN ('queued','running') AND json_extract(payload, '$.caseId') = ?").get(caseId);
	if (!existing) {
		db.prepare("INSERT INTO jobs (kind, payload, run_after, created_at, updated_at) VALUES ('draft_case', ?, ?, ?, ?)")
			.run(JSON.stringify({ caseId }), now(), now(), now());
	}
	db.prepare("UPDATE cases SET ai_state = 'queued', ai_error = NULL WHERE id = ?").run(caseId);
}

function cleanTimeline(value) {
	if (!Array.isArray(value)) throw httpError(400, "Timeline must be a list");
	return value.slice(0, 200).map(item => ({
		when: String(item.when || "").slice(0, 120),
		event: String(item.event || "").slice(0, 2000),
		sources: Array.isArray(item.sources) ? item.sources.map(String).slice(0, 20) : [],
		edited: Boolean(item.edited)
	})).filter(item => item.event.trim());
}

function cleanList(value) {
	const list = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
	return list.map(v => String(v).trim().slice(0, 80)).filter(Boolean).slice(0, 20);
}

function cleanEvidence(value) {
	if (!Array.isArray(value)) throw httpError(400, "Evidence must be a list");
	return value.slice(0, 50).map(item => {
		const url = String(item.url || "").trim().slice(0, 500);
		return {
			label: String(item.label || "").trim().slice(0, 120) || "Evidence",
			url: /^https?:\/\//i.test(url) ? url : "",
			ref: item.ref ? String(item.ref).slice(0, 20) : null
		};
	}).filter(item => item.url || item.ref);
}

function cleanValue(field, spec, value) {
	switch (spec.type) {
		case "list": return JSON.stringify(cleanList(value));
		case "evidence": return JSON.stringify(cleanEvidence(value));
		case "text": return String(value ?? "").slice(0, spec.max);
		case "enum":
			if (!spec.values.includes(value)) throw httpError(400, `Invalid ${field}`);
			return value;
		case "bool": return value == null ? null : (value ? 1 : 0);
		case "finding":
			if (value && !FINDINGS.some(f => f.key === value)) throw httpError(400, "Unknown finding");
			return value || null;
		case "punishment": {
			const keys = [...new Set(punishmentKeys(value))];
			const unknown = keys.find(k => !punishmentByKey(k));
			if (unknown) throw httpError(400, `Unknown punishment category ${unknown}`);
			return keys.length ? keys.join(",") : null;
		}
		case "personnel":
			if (value && !personnel(Number(value))) throw httpError(400, "Unknown personnel record");
			return value ? Number(value) : null;
		case "timeline": return JSON.stringify(cleanTimeline(value));
		default: throw httpError(400, `Field ${field} is not editable`);
	}
}

const updateCase = db.transaction((ref, patch, actor, reason) => {
	const row = requireCase(ref);
	const perms = casePermissions(actor, row);
	if (accessLevel(actor, row) !== "ia") throw httpError(404, "Case not found");
	if (perms.recused) throw httpError(403, `Recused: ${perms.recused}`);
	if (perms.locked) throw httpError(409, "Closed cases are locked. A director must reopen the case on appeal.");

	const sigBefore = signatureState(row);
	const changes = [];
	for (const [field, raw] of Object.entries(patch || {})) {
		const spec = EDITABLE[field];
		if (!spec) throw httpError(400, `Field ${field} cannot be edited`);
		if (!can(actor, spec.cap)) throw httpError(403, `Your role cannot change ${field}`);
		if (row.status === "approved" && !can(actor, "case.decide")) throw httpError(403, "Approved cases can only be edited by supervisors");
		const value = cleanValue(field, spec, raw);
		const before = row[field];
		if (String(before ?? "") === String(value ?? "")) continue;
		changes.push({ field, before, after: value });
	}
	if (!changes.length) return row;
	if (sigBefore !== "none" && !String(reason || "").trim()) {
		throw httpError(400, "This case carries a supervisor signature. Give a reason for the edit.");
	}

	const narrativeTouched = changes.some(c => c.field.startsWith("narrative_"));
	const sets = changes.map(c => `${c.field} = @${c.field}`);
	if (narrativeTouched) sets.push("narrative_human_edited = 1");
	const params = Object.fromEntries(changes.map(c => [c.field, c.after]));
	db.prepare(`UPDATE cases SET ${sets.join(", ")}, updated_at = @at WHERE id = @id`).run({ ...params, at: now(), id: row.id });

	const insertEdit = db.prepare("INSERT INTO case_edits (case_id, editor_id, editor_name, field, before, after, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	for (const c of changes) {
		insertEdit.run(row.id, actor.discord_id, actor.display_name || actor.username, c.field,
			c.before == null ? null : String(c.before), c.after == null ? null : String(c.after), reason || null, now());
	}

	const updated = db.prepare("SELECT * FROM cases WHERE id = ?").get(row.id);
	const sigAfter = signatureState(updated);
	audit.record(actor, "case.edit", { type: "case", ref: row.ref }, {
		fields: changes.map(c => c.field),
		reason: reason || null,
		signature: sigBefore === "valid" && sigAfter === "stale" ? "invalidated" : sigAfter
	});

	// An edit that changes signed content invalidates approval: the case goes back for review.
	if (sigBefore === "valid" && sigAfter === "stale" && row.status === "approved") {
		db.prepare("UPDATE cases SET status = 'marked_for_review', approved_at = NULL WHERE id = ?").run(row.id);
		audit.record(actor, "case.status", { type: "case", ref: row.ref }, { from: "approved", to: "marked_for_review", auto: "signed content changed" });
	}
	indexCase(row.id);
	return db.prepare("SELECT * FROM cases WHERE id = ?").get(row.id);
});

const transition = db.transaction((ref, to, actor, note) => {
	const row = requireCase(ref);
	if (accessLevel(actor, row) !== "ia") throw httpError(404, "Case not found");
	const move = allowedTransitions(actor, row).find(t => t.to === to);
	if (!move) {
		const recused = recusal(actor, row);
		throw httpError(403, recused ? `Recused: ${recused}` : `You cannot move this case from ${STATUS_LABELS[row.status]} to ${STATUS_LABELS[to] || to}`);
	}
	if (move.requiresSignature) throw httpError(409, "Approval requires a supervisor signature.");
	if (to === "closed" && signatureState(row) !== "valid") {
		throw httpError(409, "A case can only close with a current, valid supervisor signature.");
	}
	const at = now();
	db.prepare(`UPDATE cases SET status = ?, updated_at = ?, closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END WHERE id = ?`)
		.run(to, at, to, at, row.id);
	if (to === "closed" && row.status === "appealed") {
		db.prepare("UPDATE appeals SET status = 'denied', resolved_by = ?, resolved_at = ? WHERE case_id = ? AND status = 'pending'").run(actor.discord_id, at, row.id);
	}
	if (to === "appealed") {
		db.prepare("UPDATE appeals SET status = 'accepted', resolved_by = ?, resolved_at = ? WHERE case_id = ? AND status = 'pending'").run(actor.discord_id, at, row.id);
	}
	if (note) addNote(row, actor, `Status changed to ${STATUS_LABELS[to]}: ${note}`);
	audit.record(actor, "case.status", { type: "case", ref: row.ref }, { from: row.status, to, note: note || null, ownerOverride: relation(actor, row).override || undefined });
	indexCase(row.id);
	return db.prepare("SELECT * FROM cases WHERE id = ?").get(row.id);
});

const sign = db.transaction((ref, decision, actor) => {
	const row = requireCase(ref);
	const perms = casePermissions(actor, row);
	if (accessLevel(actor, row) !== "ia") throw httpError(404, "Case not found");
	if (perms.recused) throw httpError(403, `Recused: ${perms.recused}`);
	if (!perms.canSign) throw httpError(403, "You cannot sign this case in its current state.");

	const finding = cleanValue("final_finding", EDITABLE.final_finding, decision.finding);
	const punishment = cleanValue("final_punishment", EDITABLE.final_punishment, decision.punishment);
	if (!finding || !punishment) throw httpError(400, "A finding and a punishment category are required to sign.");
	const detail = String(decision.punishmentDetail || "").slice(0, 500);
	const appealable = decision.appealable ? 1 : 0;
	const notice = String(decision.notice ?? row.subject_notice ?? "").slice(0, 4000);
	const statement = String(decision.statement || "").trim().slice(0, 2000);
	const typedName = String(decision.typedName || "").trim().toLowerCase();
	const expected = String(actor.display_name || actor.username).trim().toLowerCase();
	if (!typedName || (typedName !== expected && typedName !== String(actor.username).toLowerCase())) {
		throw httpError(400, "Type your display name exactly to apply your signature.");
	}

	const at = now();
	db.prepare(`UPDATE cases SET final_finding = ?, final_punishment = ?, final_punishment_detail = ?, final_appealable = ?,
		subject_notice = ?, status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?`)
		.run(finding, punishment, detail, appealable, notice, at, at, row.id);
	const updated = db.prepare("SELECT * FROM cases WHERE id = ?").get(row.id);
	const hash = contentHash(updated);
	db.prepare(`INSERT INTO signatures (case_id, signer_id, signer_name, signer_title, finding, punishment, punishment_detail,
		appealable, statement, content_hash, signed_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(row.id, actor.discord_id, actor.display_name || actor.username, actor.title || null,
			finding, punishment, detail, appealable, statement, hash, at, row.demo);
	if (row.status === "appealed") {
		db.prepare("UPDATE appeals SET status = 'accepted', resolved_by = ?, resolved_at = ? WHERE case_id = ? AND status = 'pending'").run(actor.discord_id, at, row.id);
	}
	audit.record(actor, "case.sign", { type: "case", ref: row.ref }, { from: row.status, finding, punishment, appealable: Boolean(appealable), hash, ownerOverride: relation(actor, row).override || undefined });
	indexCase(row.id);
	return updated;
});

function addNote(row, actor, body) {
	const text = String(body || "").trim().slice(0, 4000);
	if (!text) throw httpError(400, "Note is empty");
	db.prepare("INSERT INTO case_notes (case_id, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)")
		.run(row.id, actor.discord_id, actor.display_name || actor.username, text, now());
	touch(row.id);
}

function assign(ref, agentId, actor) {
	const row = requireCase(ref);
	const perms = casePermissions(actor, row);
	if (!perms.canAssign) throw httpError(403, perms.recused ? `Recused: ${perms.recused}` : "Only supervisors can assign cases");
	if (agentId) {
		const agent = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(agentId);
		if (!agent || !can(agent, "case.view")) throw httpError(400, "That user is not an IA agent");
		if (relation(agent, row).isSubject) throw httpError(400, "An agent cannot be assigned to their own case");
	}
	db.prepare("UPDATE cases SET assigned_agent_id = ?, updated_at = ? WHERE id = ?").run(agentId || null, now(), row.id);
	audit.record(actor, "case.assign", { type: "case", ref: row.ref }, { agent: agentId || null });
}

const attachTickets = db.transaction((ref, ticketRefs, actor) => {
	const row = requireCase(ref);
	const perms = casePermissions(actor, row);
	if (!perms.canEdit) throw httpError(403, perms.recused ? `Recused: ${perms.recused}` : "You cannot change this case");
	const added = [];
	for (const tref of ticketRefs || []) {
		const ticket = db.prepare("SELECT * FROM tickets WHERE ref = ? COLLATE NOCASE").get(String(tref));
		if (!ticket) throw httpError(400, `Unknown ticket ${tref}`);
		const info = db.prepare("INSERT OR IGNORE INTO case_tickets (case_id, ticket_id, added_by, added_at) VALUES (?, ?, ?, ?)").run(row.id, ticket.id, actor.discord_id, now());
		if (info.changes) added.push(ticket.ref);
	}
	if (added.length) {
		audit.record(actor, "case.link_tickets", { type: "case", ref: row.ref }, { tickets: added });
		touch(row.id);
	}
	return added;
});

module.exports = {
	STATUS_LABELS,
	TRANSITIONS,
	EDITABLE,
	httpError,
	formatRef,
	normalizeRef,
	getCase,
	requireCase,
	relation,
	accessLevel,
	casePermissions,
	contentHash,
	signatureState,
	serializeCase,
	card,
	searchCases,
	indexCase,
	createCase,
	updateCase,
	transition,
	sign,
	addNote,
	assign,
	attachTickets,
	enqueueDraft,
	effectiveRole
};
