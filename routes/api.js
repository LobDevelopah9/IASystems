const fs = require("fs");
const path = require("path");
const express = require("express");
const config = require("../lib/config");
const { db, now, json } = require("../lib/db");
const { requireAuth, requireCap, revokeAllSessions } = require("../lib/auth");
const { can, effectiveRole, isOwner, ROLE_LABELS, RANK } = require("../lib/permissions");
const policy = require("../lib/policy");
const cases = require("../lib/cases");
const tickets = require("../lib/tickets");
const pipeline = require("../lib/pipeline");
const audit = require("../lib/audit");
const ai = require("../lib/ai");
const bot = require("../lib/bot");

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use((req, res, next) => {
	res.set("Cache-Control", "no-store, max-age=0");
	res.set("Pragma", "no-cache");
	next();
});
router.use(requireAuth);

function publicUser(user) {
	return {
		id: user.discord_id,
		username: user.username,
		displayName: user.display_name || user.username,
		avatar: user.avatar,
		role: user.role,
		roleLabel: user.roleLabel,
		callsign: user.callsign,
		badgeNumber: user.badge_number,
		title: user.title,
		robloxUsername: user.roblox_username,
		capabilities: user.capabilities
	};
}

// --- Session ------------------------------------------------------------------------

router.get("/me", (req, res) => {
	const pending = can(req.user, "case.decide")
		? db.prepare("SELECT COUNT(*) AS n FROM cases WHERE status = 'marked_for_review'").get().n : 0;
	res.json({
		user: publicUser(req.user),
		counts: { review: pending },
		policy: { findings: policy.FINDINGS, punishments: policy.punishments(), classifications: policy.CLASSIFICATIONS, statuses: cases.STATUS_LABELS },
		demo: Boolean(db.prepare("SELECT 1 FROM cases WHERE demo = 1 LIMIT 1").get())
	});
});

// --- Cases --------------------------------------------------------------------------

router.get("/cases", requireCap("case.view"), (req, res) => {
	res.json({ cases: cases.searchCases(req.user, req.query) });
});

router.post("/cases", requireCap("case.create"), (req, res) => {
	const body = req.body || {};
	const ticketRefs = Array.isArray(body.tickets) ? body.tickets : [];
	const ticketRows = ticketRefs.map(ref => {
		const t = tickets.getTicket(ref);
		if (!t) throw cases.httpError(400, `Unknown ticket ${ref}`);
		return t;
	});
	if (!String(body.title || "").trim()) throw cases.httpError(400, "A case title is required");
	let subjectId = body.subjectPersonnelId ? Number(body.subjectPersonnelId) : null;
	if (!subjectId && String(body.subjectName || "").trim()) {
		subjectId = tickets.findOrCreatePersonnel({ name: body.subjectName }).id;
	}
	const subject = subjectId ? db.prepare("SELECT * FROM personnel WHERE id = ?").get(subjectId) : null;
	if (subjectId && !subject) throw cases.httpError(400, "Unknown subject");
	if (subject?.discord_id === req.user.discord_id && !isOwner(req.user)) throw cases.httpError(403, "You cannot open a case against yourself");
	const reporterTicket = ticketRows.find(t => t.type === "report" || t.type === "ops");
	const row = cases.createCase({
		kind: body.kind,
		title: body.title,
		classification: body.classification,
		violations: body.violations,
		reporterUsername: reporterTicket?.opener_username || null,
		reporterRoblox: body.reporterRoblox || (reporterTicket ? JSON.parse(reporterTicket.intake || "{}").reporterRoblox : null) || null,
		evidence: tickets.extractEvidence(ticketRows),
		interviewPresent: tickets.participants(ticketRows).join(", "),
		subjectPersonnelId: subjectId,
		reporterId: reporterTicket?.opener_id || null,
		reporterName: reporterTicket?.opener_name || (body.reporterName ? String(body.reporterName).slice(0, 80) : null),
		anonymous: Boolean(body.anonymous) || ticketRows.some(t => t.anonymous),
		incidentAt: body.incidentAt,
		incidentLocation: body.incidentLocation,
		summary: body.summary,
		assignedAgentId: can(req.user, "case.assign") ? body.assignedAgentId || null : req.user.discord_id,
		ticketIds: ticketRows.map(t => t.id),
		draftWithAi: Boolean(body.draftWithAi) && ticketRows.length > 0,
		status: "marked_for_review"
	}, req.user, "portal");
	if (body.finalPunishment && can(req.user, "case.decide")) {
		cases.updateCase(row.ref, {
			final_punishment: body.finalPunishment,
			final_punishment_detail: body.finalPunishmentDetail || "",
			final_finding: body.finalFinding || null,
			final_appealable: body.finalAppealable
		}, req.user);
	}
	res.status(201).json({ ref: row.ref });
});

router.get("/cases/:ref", requireCap("self.cases"), (req, res) => {
	const row = cases.requireCase(req.params.ref);
	const data = cases.serializeCase(row, req.user);
	audit.record(req.user, "case.view", { type: "case", ref: row.ref }, { view: data.view, ownerOverride: cases.relation(req.user, row).override || undefined }, req.ip);
	res.json({ case: data, viewer: { name: req.user.display_name || req.user.username, id: req.user.discord_id } });
});

router.patch("/cases/:ref", requireCap("case.edit"), (req, res) => {
	const { changes, reason } = req.body || {};
	const row = cases.updateCase(req.params.ref, changes || {}, req.user, reason);
	res.json({ case: cases.serializeCase(row, req.user) });
});

// Owner-only removal of an unsigned case (e.g. test cases). Signed cases can never be deleted.
router.delete("/cases/:ref", requireCap("settings.manage"), (req, res) => {
	if (!config.OWNER_DISCORD_IDS.includes(req.user.discord_id)) throw cases.httpError(403, "Only owner accounts can delete cases");
	const row = cases.requireCase(req.params.ref);
	if (cases.relation(req.user, row).isSubject) throw cases.httpError(403, "You cannot delete a case where you are the accused");
	if (db.prepare("SELECT 1 FROM signatures WHERE case_id = ?").get(row.id)) throw cases.httpError(409, "Signed cases are permanent and cannot be deleted");
	if (String(req.body?.confirm || "").trim() !== `DELETE ${row.ref}`) throw cases.httpError(400, `Type DELETE ${row.ref} to confirm`);
	db.transaction(() => {
		db.prepare("INSERT OR REPLACE INTO case_purges (case_id, ref, purged_by, reason, purged_at) VALUES (?, ?, ?, ?, ?)")
			.run(row.id, row.ref, req.user.discord_id, String(req.body?.reason || "").slice(0, 300) || null, now());
		db.prepare("DELETE FROM jobs WHERE kind = 'draft_case' AND json_extract(payload, '$.caseId') = ?").run(row.id);
		db.prepare("DELETE FROM cases_fts WHERE case_id = ?").run(row.id);
		db.prepare("UPDATE link_groups SET case_id = NULL WHERE case_id = ?").run(row.id);
		db.prepare("DELETE FROM cases WHERE id = ?").run(row.id);
	})();
	audit.record(req.user, "case.delete", { type: "case", ref: row.ref }, { reason: req.body?.reason || null, title: row.title }, req.ip);
	res.json({ ok: true });
});

router.post("/cases/:ref/status", requireCap("case.edit"), (req, res) => {
	const row = cases.transition(req.params.ref, String(req.body?.to || ""), req.user, String(req.body?.note || "").slice(0, 1000));
	res.json({ case: cases.card(row, req.user) });
});

router.post("/cases/:ref/sign", requireCap("case.decide"), (req, res) => {
	const row = cases.sign(req.params.ref, req.body || {}, req.user);
	res.json({ case: cases.serializeCase(row, req.user) });
});

router.post("/cases/:ref/assign", requireCap("case.assign"), (req, res) => {
	cases.assign(req.params.ref, req.body?.agentId || null, req.user);
	res.json({ ok: true });
});

router.post("/cases/:ref/notes", requireCap("case.note"), (req, res) => {
	const row = cases.requireCase(req.params.ref);
	const perms = cases.casePermissions(req.user, row);
	if (cases.accessLevel(req.user, row) !== "ia" || !perms.canNote) throw cases.httpError(403, perms.recused ? `Recused: ${perms.recused}` : "Not permitted");
	cases.addNote(row, req.user, req.body?.body);
	audit.record(req.user, "case.note", { type: "case", ref: row.ref }, {}, req.ip);
	res.json({ ok: true });
});

router.post("/cases/:ref/tickets", requireCap("case.edit"), (req, res) => {
	const added = cases.attachTickets(req.params.ref, req.body?.tickets || [], req.user);
	const row = cases.requireCase(req.params.ref);
	if (added.length && req.body?.redraft && !["approved", "closed"].includes(row.status)) cases.enqueueDraft(row.id);
	res.json({ added });
});

router.post("/cases/:ref/redraft", requireCap("case.redraft"), (req, res) => {
	const row = cases.requireCase(req.params.ref);
	const perms = cases.casePermissions(req.user, row);
	if (cases.accessLevel(req.user, row) !== "ia" || !perms.canRedraft) throw cases.httpError(403, perms.recused ? `Recused: ${perms.recused}` : "This case cannot be redrafted now");
	if (!ai.providerInfo().configured) throw cases.httpError(409, "The AI provider is not configured yet. See Settings → System.");
	cases.enqueueDraft(row.id);
	audit.record(req.user, "case.redraft", { type: "case", ref: row.ref }, {}, req.ip);
	res.json({ ok: true });
});

router.post("/cases/:ref/apply-draft", requireCap("case.edit"), (req, res) => {
	pipeline.applyPendingDraft(req.params.ref, req.user);
	res.json({ ok: true });
});

router.get("/cases/:ref/history", requireCap("audit.view"), (req, res) => {
	const row = cases.requireCase(req.params.ref);
	if (cases.accessLevel(req.user, row) !== "ia") throw cases.httpError(404, "Case not found");
	const identity = can(req.user, "case.view_identity");
	const edits = db.prepare("SELECT editor_name, field, before, after, reason, created_at FROM case_edits WHERE case_id = ? ORDER BY id DESC LIMIT 300").all(row.id);
	const events = db.prepare("SELECT at, actor_name, action, detail FROM audit_log WHERE target_type = 'case' AND target_ref = ? ORDER BY id DESC LIMIT 500").all(row.ref)
		.map(e => ({ ...e, detail: json(e.detail, {}) }));
	const drafts = db.prepare("SELECT id, created_at, provider, model, status, error, input_chars FROM ai_drafts WHERE case_id = ? ORDER BY id DESC").all(row.id);
	res.json({ edits, events, drafts, identity });
});

router.get("/cases/:ref/transcripts/:ticket", requireCap("ticket.view"), (req, res) => {
	const row = cases.requireCase(req.params.ref);
	if (cases.accessLevel(req.user, row) !== "ia") throw cases.httpError(404, "Case not found");
	const ticket = tickets.getTicket(req.params.ticket);
	const linked = ticket && db.prepare("SELECT 1 FROM case_tickets WHERE case_id = ? AND ticket_id = ?").get(row.id, ticket.id);
	if (!linked) throw cases.httpError(404, "Ticket is not part of this case");
	const reveal = can(req.user, "case.view_identity");
	audit.record(req.user, "ticket.transcript_view", { type: "ticket", ref: ticket.ref }, { case: row.ref, identityRevealed: Boolean(ticket.anonymous && reveal) }, req.ip);
	res.json({ ticket: tickets.ticketSummary(ticket, req.user), intake: redactedIntake(ticket, reveal), messages: tickets.transcript(ticket, { revealIdentity: reveal }) });
});

function redactedIntake(ticket, reveal) {
	const intake = json(ticket.intake, {});
	const redact = tickets.redactor(ticket, reveal);
	return Object.fromEntries(Object.entries(intake).filter(([, v]) => v).map(([k, v]) => [k, redact(String(v))]));
}

// --- Tickets (inbox) --------------------------------------------------------------------

router.get("/tickets", requireCap("ticket.view"), (req, res) => {
	res.json({ tickets: tickets.listTickets(req.user, req.query) });
});

router.get("/tickets/:ref", requireCap("ticket.view"), (req, res) => {
	const ticket = tickets.getTicket(req.params.ref);
	if (!ticket) throw cases.httpError(404, "Ticket not found");
	const subject = ticket.subject_personnel_id ? db.prepare("SELECT discord_id FROM personnel WHERE id = ?").get(ticket.subject_personnel_id) : null;
	if (subject?.discord_id === req.user.discord_id && !isOwner(req.user)) throw cases.httpError(404, "Ticket not found");
	const reveal = can(req.user, "case.view_identity");
	audit.record(req.user, "ticket.transcript_view", { type: "ticket", ref: ticket.ref }, { identityRevealed: Boolean(ticket.anonymous && reveal) }, req.ip);
	res.json({ ticket: tickets.ticketSummary(ticket, req.user), intake: redactedIntake(ticket, reveal), messages: tickets.transcript(ticket, { revealIdentity: reveal }) });
});

router.post("/tickets/link", requireCap("case.create"), (req, res) => {
	res.json(tickets.linkTickets(Array.isArray(req.body?.tickets) ? req.body.tickets : [], req.user));
});

router.get("/attachments/:id", requireCap("ticket.view"), (req, res) => {
	const file = db.prepare("SELECT a.*, t.ref AS ticket_ref, t.subject_personnel_id FROM ticket_attachments a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ?").get(Number(req.params.id));
	if (!file?.stored_path) throw cases.httpError(404, "Attachment not stored");
	const subject = file.subject_personnel_id ? db.prepare("SELECT discord_id FROM personnel WHERE id = ?").get(file.subject_personnel_id) : null;
	if (subject?.discord_id === req.user.discord_id && !isOwner(req.user)) throw cases.httpError(404, "Attachment not stored");
	const full = path.resolve(config.DATA_DIR, file.stored_path);
	if (!full.startsWith(path.resolve(config.DATA_DIR)) || !fs.existsSync(full)) throw cases.httpError(404, "Attachment missing");
	audit.record(req.user, "ticket.attachment_view", { type: "ticket", ref: file.ticket_ref }, { attachment: file.id }, req.ip);
	const inline = /^(image|video|audio)\//.test(file.content_type || "");
	res.set("Content-Type", inline ? file.content_type : "application/octet-stream");
	res.set("Content-Disposition", inline ? "inline" : "attachment; filename=\"blocked\"");
	res.set("X-Content-Type-Options", "nosniff");
	if (!inline) throw cases.httpError(415, "Only images, video, and audio can be viewed in the portal");
	fs.createReadStream(full).pipe(res);
});

// --- Personnel -------------------------------------------------------------------------

router.get("/personnel", requireCap("case.view"), (req, res) => {
	const q = `%${String(req.query.q || "").trim()}%`;
	const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM cases c WHERE c.subject_personnel_id = p.id) AS case_count
		FROM personnel p WHERE (p.name LIKE @q OR p.callsign LIKE @q OR p.roblox_username LIKE @q OR p.discord_username LIKE @q)
		AND (p.discord_id IS NULL OR p.discord_id <> @me) ORDER BY p.name LIMIT 200`).all({ q, me: isOwner(req.user) ? "" : req.user.discord_id });
	res.json({ personnel: rows.map(p => ({ id: p.id, name: p.name, callsign: p.callsign, robloxUsername: p.roblox_username, discordUsername: p.discord_username, department: p.department, rank: p.rank, discordId: p.discord_id, caseCount: p.case_count, demo: Boolean(p.demo) })) });
});

router.post("/personnel", requireCap("personnel.manage"), (req, res) => {
	const name = String(req.body?.name || "").trim().slice(0, 80);
	if (!name) throw cases.httpError(400, "Name is required");
	const info = db.prepare("INSERT INTO personnel (name, callsign, roblox_username, discord_username, rank, department, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run(name, req.body.callsign || null, req.body.robloxUsername || null, req.body.discordUsername || null, req.body.rank || null, req.body.department || "SAHP", now(), now());
	audit.record(req.user, "personnel.create", { type: "personnel", ref: info.lastInsertRowid }, { name }, req.ip);
	res.status(201).json({ id: info.lastInsertRowid });
});

router.patch("/personnel/:id", requireCap("personnel.manage"), (req, res) => {
	const person = db.prepare("SELECT * FROM personnel WHERE id = ?").get(Number(req.params.id));
	if (!person) throw cases.httpError(404, "Not found");
	if (person.discord_id === req.user.discord_id && !isOwner(req.user)) throw cases.httpError(403, "You cannot edit your own personnel record");
	const fields = { callsign: 40, roblox_username: 40, discord_username: 40, rank: 60, department: 40, notes: 1000 };
	const updates = Object.entries(fields).filter(([k]) => k in (req.body || {})).map(([k, max]) => [k, String(req.body[k] || "").slice(0, max) || null]);
	if (!person.discord_id && "name" in (req.body || {})) updates.push(["name", String(req.body.name).trim().slice(0, 80) || person.name]);
	if (updates.length) {
		db.prepare(`UPDATE personnel SET ${updates.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...updates.map(([, v]) => v), now(), person.id);
		audit.record(req.user, "personnel.edit", { type: "personnel", ref: person.id }, { fields: updates.map(([k]) => k) }, req.ip);
	}
	res.json({ ok: true });
});

// --- Users & agents ----------------------------------------------------------------------

function userRow(u, viewer) {
	const role = effectiveRole(u);
	return {
		id: u.discord_id,
		username: u.username,
		displayName: u.display_name || u.username,
		avatar: u.avatar,
		role,
		roleLabel: ROLE_LABELS[role],
		mappedRole: u.mapped_role,
		override: u.role_override,
		owner: config.OWNER_DISCORD_IDS.includes(u.discord_id),
		suspended: Boolean(u.suspended),
		suspendedReason: can(viewer, "users.manage") ? u.suspended_reason : null,
		inGuild: Boolean(u.in_guild),
		callsign: u.callsign,
		badgeNumber: u.badge_number,
		title: u.title,
		robloxUsername: u.roblox_username,
		lastLoginAt: u.last_login_at,
		lastSeenAt: u.last_seen_at,
		activeCases: db.prepare("SELECT COUNT(*) AS n FROM cases WHERE assigned_agent_id = ? AND status NOT IN ('closed')").get(u.discord_id).n,
		sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE discord_id = ? AND revoked = 0 AND expires_at > ?").get(u.discord_id, now()).n,
		demo: Boolean(u.demo)
	};
}

router.get("/users", requireCap("users.view"), (req, res) => {
	const rows = db.prepare("SELECT * FROM users ORDER BY display_name COLLATE NOCASE").all();
	res.json({ users: rows.map(u => userRow(u, req.user)), roles: Object.entries(ROLE_LABELS).map(([key, label]) => ({ key, label })) });
});

router.get("/agents", requireCap("case.view"), (req, res) => {
	const rows = db.prepare("SELECT * FROM users").all().filter(u => can(u, "case.view"));
	res.json({ agents: rows.map(u => ({ id: u.discord_id, name: u.display_name || u.username, callsign: u.callsign, robloxUsername: u.roblox_username, role: effectiveRole(u) })) });
});

router.patch("/users/:id", requireCap("users.manage"), (req, res) => {
	const target = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(req.params.id);
	if (!target) throw cases.httpError(404, "User not found");
	const body = req.body || {};
	const self = target.discord_id === req.user.discord_id;
	const updates = {};

	if ("override" in body) {
		const value = body.override || null;
		if (value && !["director", "supervisor", "investigator", "trooper", "none"].includes(value)) throw cases.httpError(400, "Unknown role");
		if (self) throw cases.httpError(403, "You cannot change your own role");
		updates.role_override = value;
	}
	if ("suspended" in body) {
		if (self) throw cases.httpError(403, "You cannot suspend yourself");
		if (config.OWNER_DISCORD_IDS.includes(target.discord_id)) throw cases.httpError(403, "Owner accounts cannot be suspended here");
		updates.suspended = body.suspended ? 1 : 0;
		updates.suspended_reason = body.suspended ? String(body.reason || "").slice(0, 300) || null : null;
	}
	for (const [key, column, max] of [["callsign", "callsign", 30], ["badgeNumber", "badge_number", 20], ["title", "title", 80], ["robloxUsername", "roblox_username", 40]]) {
		if (key in body) updates[column] = String(body[key] || "").trim().slice(0, max) || null;
	}
	if (!Object.keys(updates).length) return res.json({ user: userRow(target, req.user) });

	// Never leave the portal without an active director.
	const after = { ...target, ...updates };
	if (effectiveRole(target) === "director" && effectiveRole(after) !== "director") {
		const directors = db.prepare("SELECT * FROM users").all().filter(u => u.discord_id !== target.discord_id && effectiveRole(u) === "director");
		if (!directors.length) throw cases.httpError(409, "This would leave the portal without a Head of IA");
	}
	db.prepare(`UPDATE users SET ${Object.keys(updates).map(k => `${k} = @${k}`).join(", ")}, updated_at = @at WHERE discord_id = @id`)
		.run({ ...updates, at: now(), id: target.discord_id });
	const roleChanged = effectiveRole(target) !== effectiveRole(after);
	if (roleChanged && RANK[effectiveRole(after)] < RANK[effectiveRole(target)]) revokeAllSessions(target.discord_id);
	if (updates.suspended) revokeAllSessions(target.discord_id);
	audit.record(req.user, "user.update", { type: "user", ref: target.discord_id }, {
		fields: Object.keys(updates), role: roleChanged ? { from: effectiveRole(target), to: effectiveRole(after) } : undefined, reason: body.reason || undefined
	}, req.ip);
	res.json({ user: userRow(db.prepare("SELECT * FROM users WHERE discord_id = ?").get(target.discord_id), req.user) });
});

router.post("/users/:id/revoke-sessions", requireCap("users.manage"), (req, res) => {
	const count = revokeAllSessions(req.params.id);
	audit.record(req.user, "user.revoke_sessions", { type: "user", ref: req.params.id }, { count }, req.ip);
	res.json({ revoked: count });
});

router.post("/users/sync", requireCap("users.manage"), wrap(async (req, res) => {
	const result = await bot.fullSync();
	audit.record(req.user, "user.sync", { type: "system" }, result, req.ip);
	res.json(result);
}));

// --- Audit -------------------------------------------------------------------------------

router.get("/audit", requireCap("audit.view"), (req, res) => {
	const where = [];
	const params = {};
	if (req.query.action) { where.push("action LIKE @action"); params.action = `${req.query.action}%`; }
	if (req.query.actor) { where.push("actor_name LIKE @actor"); params.actor = `%${req.query.actor}%`; }
	if (req.query.target) { where.push("target_ref LIKE @target"); params.target = `%${req.query.target}%`; }
	const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
	where.push("id < @before");
	params.before = before;
	const rows = db.prepare(`SELECT id, at, actor_id, actor_name, action, target_type, target_ref, detail, ip FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 100`).all(params);
	const showIp = can(req.user, "users.manage");
	res.json({
		entries: rows.map(r => ({ ...r, detail: json(r.detail, {}), ip: showIp ? r.ip : null })),
		chain: req.query.verify ? audit.verifyChain() : null
	});
});

// --- Settings & system -----------------------------------------------------------------

router.get("/settings", requireCap("settings.manage"), wrap(async (req, res) => {
	const [roles, channels] = await Promise.all([bot.guildRoles().catch(() => []), bot.guildChannels().catch(() => [])]);
	res.json({
		punishments: policy.punishments(),
		nextCaseNumber: Math.max(Number(require("../lib/db").getSetting("next_case_number", 0)) || Number(process.env.CASE_NUMBER_START) || 644,
			(db.prepare("SELECT MAX(case_number) AS n FROM cases WHERE demo = 0").get().n || 0) + 1),
		roleMap: policy.roleMap(),
		discord: policy.discordSettings(),
		guildRoles: roles,
		guildChannels: channels
	});
}));

router.put("/settings/punishments", requireCap("settings.manage"), (req, res) => {
	policy.savePunishments(req.body?.punishments, req.user.discord_id);
	audit.record(req.user, "settings.punishments", { type: "settings", ref: "punishments" }, { count: req.body.punishments.length }, req.ip);
	res.json({ punishments: policy.punishments() });
});

router.put("/settings/case-number", requireCap("settings.manage"), (req, res) => {
	const next = Number(req.body?.next);
	const highest = db.prepare("SELECT MAX(case_number) AS n FROM cases WHERE demo = 0").get().n || 0;
	if (!Number.isInteger(next) || next < 1 || next > 8999) throw cases.httpError(400, "Enter a case number between 1 and 8999");
	if (next <= highest) throw cases.httpError(409, `Case #${String(highest).padStart(4, "0")} already exists. The next number must be higher.`);
	require("../lib/db").setSetting("next_case_number", next, req.user.discord_id);
	audit.record(req.user, "settings.case_number", { type: "settings", ref: "case_number" }, { next }, req.ip);
	res.json({ next });
});

router.put("/settings/roles", requireCap("settings.manage"), wrap(async (req, res) => {
	policy.saveRoleMap(req.body?.roleMap || {}, req.user.discord_id);
	audit.record(req.user, "settings.role_map", { type: "settings", ref: "role_map" }, policy.roleMap(), req.ip);
	const sync = await bot.fullSync().catch(error => ({ ok: false, error: error.message }));
	res.json({ roleMap: policy.roleMap(), sync });
}));

router.put("/settings/discord", requireCap("settings.manage"), wrap(async (req, res) => {
	policy.saveDiscordSettings(req.body || {}, req.user.discord_id);
	audit.record(req.user, "settings.discord", { type: "settings", ref: "discord" }, policy.discordSettings(), req.ip);
	await bot.registerCommands().catch(() => {});
	res.json({ discord: policy.discordSettings() });
}));

router.get("/system", requireCap("settings.manage"), (req, res) => {
	const discord = policy.discordSettings();
	const roleMap = policy.roleMap();
	const jobs = db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all();
	res.json({
		publicUrl: config.PUBLIC_URL,
		redirectUri: `${config.PUBLIC_URL}/auth/callback`,
		oauth: { configured: Boolean(config.DISCORD_CLIENT_ID && config.DISCORD_CLIENT_SECRET) },
		bot: { ...bot.status(), inviteUrl: bot.inviteUrl() },
		discord,
		roleMapComplete: ["director", "supervisor", "investigator"].every(r => roleMap[r]?.length),
		ai: ai.providerInfo(),
		jobs: Object.fromEntries(jobs.map(j => [j.status, j.n])),
		owners: config.OWNER_DISCORD_IDS.length,
		dataDir: config.DATA_DIR,
		persistent: config.DATA_DIR.startsWith("/data"),
		demo: {
			cases: db.prepare("SELECT COUNT(*) AS n FROM cases WHERE demo = 1").get().n,
			tickets: db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE demo = 1").get().n
		}
	});
});

router.post("/system/ai-test", requireCap("settings.manage"), wrap(async (req, res) => {
	const result = await ai.testConnection();
	audit.record(req.user, "system.ai_test", { type: "system" }, { ok: result.ok, provider: result.provider, model: result.model }, req.ip);
	res.json(result);
}));

router.post("/system/purge-demo", requireCap("settings.manage"), (req, res) => {
	if (req.body?.confirm !== "PURGE DEMO DATA") throw cases.httpError(400, "Type PURGE DEMO DATA to confirm");
	const result = require("../lib/seed").purgeDemo();
	audit.record(req.user, "system.purge_demo", { type: "system" }, result, req.ip);
	res.json(result);
});

// --- Member self-service ----------------------------------------------------------------

router.get("/my/cases", requireCap("self.cases"), (req, res) => {
	const rows = db.prepare(`SELECT c.* FROM cases c JOIN personnel p ON p.id = c.subject_personnel_id
		WHERE p.discord_id = ? AND c.status IN ('approved', 'appealed', 'closed') ORDER BY c.updated_at DESC`).all(req.user.discord_id);
	res.json({ cases: rows.map(row => cases.serializeCase(row, req.user, { asSubject: true })) });
});

router.post("/my/cases/:ref/appeal", requireCap("self.cases"), (req, res) => {
	const row = cases.requireCase(req.params.ref);
	const view = cases.serializeCase(row, req.user);
	if (view.view !== "subject" || !view.canAppeal) throw cases.httpError(403, "This case cannot be appealed");
	const reason = String(req.body?.reason || "").trim();
	if (reason.length < 20) throw cases.httpError(400, "Explain your appeal in at least 20 characters");
	db.prepare("INSERT INTO appeals (case_id, requested_by, reason, created_at) VALUES (?, ?, ?, ?)").run(row.id, req.user.discord_id, reason.slice(0, 4000), now());
	cases.indexCase(row.id);
	audit.record(req.user, "case.appeal_request", { type: "case", ref: row.ref }, {}, req.ip);
	res.json({ ok: true });
});

router.use((error, req, res, next) => {
	const status = error.status || 500;
	if (status >= 500) console.error("[api]", error);
	res.status(status).json({ error: status >= 500 ? "Internal error" : error.message });
});

module.exports = router;
