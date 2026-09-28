const { db, now, json } = require("./db");
const { can, isOwner } = require("./permissions");
const audit = require("./audit");
const cases = require("./cases");

const TYPE_LABELS = { report: "Trooper report", interview: "Interview / interrogation", ops: "OPS / system report" };

// Ticket events give reports a precise, timestamped record of who opened, joined, linked, and closed a ticket.
function addEvent(ticketId, kind, { actorId = null, actorName = null, subjectId = null, subjectName = null, detail = "", at = now() } = {}) {
	db.prepare("INSERT INTO ticket_events (ticket_id, at, kind, actor_id, actor_name, subject_id, subject_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run(ticketId, at, kind, actorId, actorName ? String(actorName).slice(0, 80) : null, subjectId, subjectName ? String(subjectName).slice(0, 80) : null, String(detail || "").slice(0, 500));
}

function events(ticketId) {
	return db.prepare("SELECT at, kind, actor_id, actor_name, subject_id, subject_name, detail FROM ticket_events WHERE ticket_id = ? ORDER BY at, id").all(ticketId);
}

function formatTicketRef(id) {
	return `T-${String(id).padStart(4, "0")}`;
}

function getTicket(ref) {
	return db.prepare("SELECT * FROM tickets WHERE ref = ? COLLATE NOCASE").get(String(ref || "").trim());
}

function ticketByChannel(channelId) {
	return db.prepare("SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'").get(channelId);
}

function findOrCreatePersonnel({ discordId, name, callsign }) {
	if (discordId) {
		const existing = db.prepare("SELECT * FROM personnel WHERE discord_id = ?").get(discordId);
		if (existing) return existing;
	}
	const cleanName = String(name || "").trim().slice(0, 80);
	if (!cleanName) return null;
	if (!discordId) {
		const byName = db.prepare("SELECT * FROM personnel WHERE name = ? COLLATE NOCASE OR (callsign IS NOT NULL AND callsign = ? COLLATE NOCASE)").get(cleanName, cleanName);
		if (byName) return byName;
	}
	const info = db.prepare("INSERT INTO personnel (discord_id, name, callsign, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
		.run(discordId || null, cleanName, callsign || null, now(), now());
	return db.prepare("SELECT * FROM personnel WHERE id = ?").get(info.lastInsertRowid);
}

const openTicket = db.transaction(data => {
	const info = db.prepare(`
		INSERT INTO tickets (type, guild_id, channel_id, opener_id, opener_name, opener_username, anonymous, subject_personnel_id, subject_text,
			intake, target_case_id, opened_at, demo)
		VALUES (@type, @guildId, @channelId, @openerId, @openerName, @openerUsername, @anonymous, @subject, @subjectText, @intake, @targetCase, @at, @demo)
	`).run({
		type: data.type,
		guildId: data.guildId || null,
		channelId: data.channelId || null,
		openerId: data.openerId || null,
		openerName: data.openerName || null,
		openerUsername: data.openerUsername || null,
		anonymous: data.anonymous ? 1 : 0,
		subject: data.subjectPersonnelId || null,
		subjectText: data.subjectText || null,
		intake: JSON.stringify(data.intake || {}),
		targetCase: data.targetCaseId || null,
		at: data.openedAt || now(),
		demo: data.demo ? 1 : 0
	});
	const ref = formatTicketRef(info.lastInsertRowid);
	db.prepare("UPDATE tickets SET ref = ? WHERE id = ?").run(ref, info.lastInsertRowid);
	return db.prepare("SELECT * FROM tickets WHERE id = ?").get(info.lastInsertRowid);
});

function setChannel(ticketId, channelId) {
	db.prepare("UPDATE tickets SET channel_id = ? WHERE id = ?").run(channelId, ticketId);
}

// Stores a closed ticket's transcript. messages: [{ messageId, authorId, authorName, isBot, content, attachments, createdAt }]
const storeTranscript = db.transaction((ticketId, messages) => {
	db.prepare("DELETE FROM ticket_messages WHERE ticket_id = ?").run(ticketId);
	const insert = db.prepare(`INSERT INTO ticket_messages (ticket_id, seq, message_id, author_id, author_name, is_bot, content, attachments, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	messages.forEach((m, index) => {
		insert.run(ticketId, index + 1, m.messageId || null, m.authorId || null, m.authorName || "Unknown",
			m.isBot ? 1 : 0, String(m.content || ""), JSON.stringify(m.attachments || []), m.createdAt || now());
	});
	db.prepare("UPDATE tickets SET message_count = ? WHERE id = ?").run(messages.length, ticketId);
});

// Called when a ticket closes. Decides whether a case gets created, extended, or waits for linked tickets.
const closeTicket = db.transaction((ticketId, actor, reason) => {
	const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
	if (!ticket) throw cases.httpError(404, "Ticket not found");
	db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, close_reason = ? WHERE id = ?")
		.run(now(), actor?.discord_id || null, reason || null, ticketId);
	addEvent(ticketId, "closed", { actorId: actor?.discord_id, actorName: actor?.display_name || actor?.username, detail: reason ? `Reason: ${reason}` : "" });
	audit.record(actor, "ticket.close", { type: "ticket", ref: ticket.ref }, { reason: reason || null, messages: ticket.message_count });
	return routeClosedTicket(ticketId);
});

function routeClosedTicket(ticketId) {
	const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
	const existing = db.prepare("SELECT case_id FROM case_tickets WHERE ticket_id = ?").get(ticketId);
	if (existing) {
		const row = db.prepare("SELECT * FROM cases WHERE id = ?").get(existing.case_id);
		if (row && !["approved", "closed"].includes(row.status)) cases.enqueueDraft(row.id);
		return { action: "extended", caseRef: row?.ref };
	}

	// Interview opened against a specific case: attach and redraft.
	if (ticket.target_case_id) {
		const row = db.prepare("SELECT * FROM cases WHERE id = ?").get(ticket.target_case_id);
		if (row) {
			db.prepare("INSERT OR IGNORE INTO case_tickets (case_id, ticket_id, added_by, added_at) VALUES (?, ?, NULL, ?)").run(row.id, ticketId, now());
			if (!["approved", "closed"].includes(row.status)) cases.enqueueDraft(row.id);
			audit.record(null, "case.link_tickets", { type: "case", ref: row.ref }, { tickets: [ticket.ref], via: "interview" });
			cases.indexCase(row.id);
			return { action: "extended", caseRef: row.ref };
		}
	}

	// Pre-linked group: wait until every ticket in the group is closed, then draft one merged case.
	if (ticket.link_group_id) {
		const group = db.prepare("SELECT * FROM link_groups WHERE id = ?").get(ticket.link_group_id);
		if (group?.case_id) {
			db.prepare("INSERT OR IGNORE INTO case_tickets (case_id, ticket_id, added_by, added_at) VALUES (?, ?, NULL, ?)").run(group.case_id, ticketId, now());
			cases.enqueueDraft(group.case_id);
			return { action: "extended", caseRef: db.prepare("SELECT ref FROM cases WHERE id = ?").get(group.case_id)?.ref };
		}
		const members = db.prepare("SELECT * FROM tickets WHERE link_group_id = ? ORDER BY opened_at").all(ticket.link_group_id);
		if (members.some(t => t.status !== "closed")) return { action: "waiting", open: members.filter(t => t.status !== "closed").map(t => t.ref) };
		const row = createCaseFromTickets(members, "link");
		db.prepare("UPDATE link_groups SET case_id = ? WHERE id = ?").run(row.id, ticket.link_group_id);
		return { action: "created", caseRef: row.ref };
	}

	// Stand-alone interviews wait in the ticket inbox for a supervisor to attach them.
	if (ticket.type === "interview") return { action: "inbox" };

	const row = createCaseFromTickets([ticket], "bot");
	return { action: "created", caseRef: row.ref };
}

function createCaseFromTickets(tickets, via) {
	const primary = tickets.find(t => t.type === "report") || tickets.find(t => t.type === "ops") || tickets[0];
	const intake = json(primary.intake, {});
	const subjectTicket = tickets.find(t => t.subject_personnel_id);
	const subject = subjectTicket ? subjectTicket.subject_personnel_id : null;
	const subjectName = subject ? db.prepare("SELECT name FROM personnel WHERE id = ?").get(subject)?.name : (primary.subject_text || "");
	const kind = primary.type === "ops" ? "ops" : "misconduct";
	const title = kind === "ops"
		? `OPS report: ${String(intake.summary || intake.system || "System issue").slice(0, 90)}`
		: `${subjectName || "Unidentified trooper"}${intake.allegation ? `: ${String(intake.allegation).slice(0, 80)}` : ""}`;
	const isReport = primary.type !== "interview";
	return cases.createCase({
		kind,
		title,
		violations: kind === "misconduct" && intake.allegation ? [intake.allegation] : [],
		subjectPersonnelId: subject,
		reporterId: isReport ? primary.opener_id : null,
		reporterName: isReport ? primary.opener_name : null,
		reporterUsername: isReport ? primary.opener_username : null,
		reporterRoblox: isReport ? intake.reporterRoblox || null : null,
		anonymous: tickets.some(t => t.anonymous),
		incidentAt: intake.when || "",
		incidentLocation: intake.location || "",
		evidence: extractEvidence(tickets),
		interviewPresent: participants(tickets).join(", "),
		ticketIds: tickets.map(t => t.id),
		draftWithAi: true,
		demo: tickets.every(t => t.demo)
	}, null, via);
}

const URL_PATTERN = /https?:\/\/[^\s<>()"']+/gi;

// Evidence is collected from the transcripts directly, never from the model, so links cannot be invented.
function extractEvidence(tickets) {
	const out = [];
	const seen = new Set();
	for (const t of tickets) {
		const rows = db.prepare("SELECT seq, author_name, is_bot, content FROM ticket_messages WHERE ticket_id = ? ORDER BY seq").all(t.id);
		for (const m of rows) {
			for (const raw of String(m.content || "").match(URL_PATTERN) || []) {
				const url = raw.replace(/[.,;:!?]+$/, "");
				if (seen.has(url) || /discord\.com\/channels/i.test(url)) continue;
				seen.add(url);
				const clip = /medal\.tv|youtu|streamable|twitch\.tv|clips|gyazo|imgur|outplayed/i.test(url);
				out.push({ label: `${m.author_name}'s ${clip ? "clip" : "link"}`, url, ref: `${t.ref}#${m.seq}` });
			}
		}
		for (const a of db.prepare("SELECT a.seq, a.filename, m.author_name FROM ticket_attachments a LEFT JOIN ticket_messages m ON m.ticket_id = a.ticket_id AND m.seq = a.seq WHERE a.ticket_id = ?").all(t.id)) {
			out.push({ label: `${a.author_name || "Attachment"}: ${a.filename}`, url: "", ref: `${t.ref}#${a.seq}` });
		}
		out.push({ label: `Ticket transcript ${t.ref}${t.type === "interview" ? " (interview)" : ""}`, url: "", ref: `${t.ref}#1` });
	}
	return out;
}

function participants(tickets) {
	const names = new Set();
	for (const t of tickets) {
		for (const r of db.prepare("SELECT DISTINCT author_name FROM ticket_messages WHERE ticket_id = ? AND is_bot = 0").all(t.id)) names.add(r.author_name);
	}
	return [...names].filter(Boolean);
}

const linkTickets = db.transaction((refs, actor) => {
	if (!can(actor, "case.create")) throw cases.httpError(403, "Only IA staff can link tickets");
	const tickets = refs.map(ref => {
		const t = getTicket(ref);
		if (!t) throw cases.httpError(400, `Unknown ticket ${ref}`);
		return t;
	});
	if (tickets.length < 2) throw cases.httpError(400, "Link at least two tickets");
	const attached = tickets.map(t => db.prepare("SELECT c.ref FROM case_tickets ct JOIN cases c ON c.id = ct.case_id WHERE ct.ticket_id = ?").get(t.id)).find(Boolean);
	if (attached) throw cases.httpError(409, `One of these tickets already belongs to ${attached.ref}. Attach the others from the portal.`);
	const groupIds = [...new Set(tickets.map(t => t.link_group_id).filter(Boolean))];
	let groupId = groupIds[0];
	if (!groupId) {
		groupId = db.prepare("INSERT INTO link_groups (created_by, created_at) VALUES (?, ?)").run(actor.discord_id, now()).lastInsertRowid;
	}
	for (const t of tickets) db.prepare("UPDATE tickets SET link_group_id = ? WHERE id = ?").run(groupId, t.id);
	for (const other of groupIds.slice(1)) db.prepare("UPDATE tickets SET link_group_id = ? WHERE link_group_id = ?").run(groupId, other);
	audit.record(actor, "ticket.link", { type: "link_group", ref: groupId }, { tickets: tickets.map(t => t.ref) });
	for (const t of tickets) {
		addEvent(t.id, "linked", { actorId: actor?.discord_id, actorName: actor?.display_name || actor?.username, detail: `Linked with ${tickets.filter(o => o.id !== t.id).map(o => o.ref).join(", ")} so one merged case is drafted` });
	}
	const members = db.prepare("SELECT * FROM tickets WHERE link_group_id = ?").all(groupId);
	if (members.every(t => t.status === "closed")) {
		const row = createCaseFromTickets(members, "link");
		db.prepare("UPDATE link_groups SET case_id = ? WHERE id = ?").run(row.id, groupId);
		return { groupId, caseRef: row.ref, tickets: members.map(t => t.ref) };
	}
	return { groupId, caseRef: null, tickets: members.map(t => t.ref) };
});

// --- Reading transcripts ------------------------------------------------------

function redactor(ticket, revealIdentity) {
	if (!ticket.anonymous || revealIdentity || !ticket.opener_id) return text => text;
	const names = new Set([ticket.opener_name].filter(Boolean));
	for (const row of db.prepare("SELECT DISTINCT author_name FROM ticket_messages WHERE ticket_id = ? AND author_id = ?").all(ticket.id, ticket.opener_id)) {
		if (row.author_name) names.add(row.author_name);
	}
	const patterns = [...names].filter(n => n.length >= 3).map(n => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
	return text => {
		let out = String(text || "").replace(new RegExp(`<@!?${ticket.opener_id}>`, "g"), "@Anonymous Reporter");
		for (const p of patterns) out = out.replace(p, "[REDACTED]");
		return out;
	};
}

// Only Discord's CDN is ever used for avatar images.
function safeAvatar(url) {
	return /^https:\/\/cdn\.discordapp\.com\//.test(String(url || "")) ? url : null;
}

function avatarOf(discordId) {
	return discordId ? db.prepare("SELECT avatar FROM users WHERE discord_id = ?").get(discordId)?.avatar || null : null;
}

function transcript(ticket, { revealIdentity }) {
	const redact = redactor(ticket, revealIdentity);
	const hide = ticket.anonymous && !revealIdentity;
	const attachments = db.prepare("SELECT id, seq, filename, content_type, size FROM ticket_attachments WHERE ticket_id = ?").all(ticket.id);
	return db.prepare("SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY seq").all(ticket.id).map(m => ({
		seq: m.seq,
		ref: `${ticket.ref}#${m.seq}`,
		author: hide && m.author_id === ticket.opener_id ? "Anonymous Reporter" : m.author_name,
		avatar: hide && m.author_id === ticket.opener_id ? null : safeAvatar(m.author_avatar || avatarOf(m.author_id)),
		authorRole: m.is_bot ? "bot" : (m.author_id === ticket.opener_id ? (ticket.type === "interview" ? "staff" : "reporter") : "participant"),
		content: redact(m.content),
		createdAt: m.created_at,
		attachments: attachments.filter(a => a.seq === m.seq).map(a => ({ id: a.id, filename: a.filename, contentType: a.content_type, size: a.size }))
	}));
}

function ticketSummary(t, user) {
	const identity = can(user, "case.view_identity");
	const caseRow = db.prepare("SELECT c.ref, c.status FROM case_tickets ct JOIN cases c ON c.id = ct.case_id WHERE ct.ticket_id = ?").get(t.id);
	const intake = json(t.intake, {});
	const subject = t.subject_personnel_id ? db.prepare("SELECT name, callsign FROM personnel WHERE id = ?").get(t.subject_personnel_id) : null;
	return {
		ref: t.ref,
		type: t.type,
		typeLabel: TYPE_LABELS[t.type],
		status: t.status,
		anonymous: Boolean(t.anonymous),
		opener: t.anonymous && !identity ? null : t.opener_name,
		subject: subject?.name || t.subject_text || null,
		allegation: intake.allegation || intake.summary || intake.reason || "",
		openedAt: t.opened_at,
		closedAt: t.closed_at,
		messageCount: t.message_count,
		linkGroup: t.link_group_id,
		caseRef: caseRow?.ref || null,
		demo: Boolean(t.demo)
	};
}

function listTickets(user, { state = "all", q = "" } = {}) {
	if (!can(user, "ticket.view")) throw cases.httpError(403, "Not permitted");
	const where = [];
	if (state === "unattached") where.push("t.status = 'closed' AND NOT EXISTS (SELECT 1 FROM case_tickets ct WHERE ct.ticket_id = t.id)");
	if (state === "open") where.push("t.status = 'open'");
	// Never surface tickets where the viewer is the subject.
	where.push("NOT EXISTS (SELECT 1 FROM personnel p WHERE p.id = t.subject_personnel_id AND p.discord_id = @me)");
	const rows = db.prepare(`SELECT t.* FROM tickets t WHERE ${where.join(" AND ")} ORDER BY t.opened_at DESC LIMIT 300`).all({ me: isOwner(user) ? "" : user.discord_id });
	const needle = String(q || "").trim().toLowerCase();
	return rows.map(t => ticketSummary(t, user)).filter(t => !needle || [t.ref, t.subject, t.opener, t.allegation].some(v => String(v || "").toLowerCase().includes(needle)));
}

module.exports = {
	TYPE_LABELS,
	formatTicketRef,
	getTicket,
	ticketByChannel,
	findOrCreatePersonnel,
	openTicket,
	addEvent,
	events,
	setChannel,
	storeTranscript,
	closeTicket,
	routeClosedTicket,
	createCaseFromTickets,
	extractEvidence,
	participants,
	linkTickets,
	transcript,
	ticketSummary,
	listTickets,
	safeAvatar,
	avatarOf,
	redactor
};
