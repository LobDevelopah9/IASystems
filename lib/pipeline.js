const crypto = require("crypto");
const { db, now, json } = require("./db");
const ai = require("./ai");
const audit = require("./audit");
const cases = require("./cases");
const tickets = require("./tickets");
const { punishments } = require("./policy");

const AGENT_NAME = "IA Drafting Agent";

function linkedTickets(caseId) {
	return db.prepare(`SELECT t.* FROM case_tickets ct JOIN tickets t ON t.id = ct.ticket_id WHERE ct.case_id = ? ORDER BY t.opened_at`).all(caseId);
}

function bundleFor(caseId) {
	// The report is internal to IA, so the reporter is named even on anonymous reports.
	// It is kept from the accused by access rules, not by leaving it out of the file.
	return linkedTickets(caseId).map(ticket => ({ ticket, intake: json(ticket.intake, {}), messages: tickets.transcript(ticket, { revealIdentity: true }) }));
}

function contextFor(row) {
	const subject = row.subject_personnel_id ? db.prepare("SELECT * FROM personnel WHERE id = ?").get(row.subject_personnel_id) : null;
	const agent = row.assigned_agent_id ? db.prepare("SELECT * FROM users WHERE discord_id = ?").get(row.assigned_agent_id) : null;
	return {
		caseNumber: row.ref,
		investigator: agent ? [agent.title, agent.display_name || agent.username, agent.roblox_username ? `(ROBLOX ${agent.roblox_username})` : null].filter(Boolean).join(" ") : null,
		accused: subject ? [subject.rank, subject.name, subject.roblox_username ? `(ROBLOX ${subject.roblox_username})` : null].filter(Boolean).join(" ") : null,
		reporter: row.reporter_name ? [row.reporter_name, row.reporter_roblox ? `(ROBLOX ${row.reporter_roblox})` : null].filter(Boolean).join(" ") : null,
		anonymous: Boolean(row.anonymous)
	};
}

// Adds transcript evidence the case does not list yet. Human-added entries are kept.
function mergeEvidence(row) {
	const existing = json(row.evidence, []);
	const keys = new Set(existing.map(e => e.url || e.ref));
	const found = tickets.extractEvidence(linkedTickets(row.id)).filter(e => !keys.has(e.url || e.ref));
	return JSON.stringify([...existing, ...found]);
}

function applyNarrative(caseId, narrative, sources) {
	const row = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId);
	db.prepare(`UPDATE cases SET
		narrative_summary = @summary, narrative_timeline = @timeline, narrative_excerpts = @excerpts,
		narrative_interview = @interview, narrative_location = @location, narrative_sources = @sources,
		conclusion = @conclusion, interview_notes = @interviewNotes,
		violations = CASE WHEN @violations <> '[]' THEN @violations ELSE violations END,
		classification = CASE WHEN @classification <> '' THEN @classification ELSE classification END,
		reporter_roblox = COALESCE(reporter_roblox, NULLIF(@accuserRoblox, '')),
		narrative_human_edited = 0, pending_draft_id = NULL,
		title = CASE WHEN @title <> '' THEN @title ELSE title END,
		incident_at = CASE WHEN incident_at = '' THEN @incidentAt ELSE incident_at END,
		incident_location = CASE WHEN incident_location = '' THEN @incidentLocation ELSE incident_location END,
		updated_at = @at
		WHERE id = @id`).run({
		id: caseId,
		summary: narrative.summary.text,
		timeline: JSON.stringify(narrative.timeline),
		excerpts: JSON.stringify(narrative.excerpts),
		interview: narrative.interview.text,
		location: narrative.location.text,
		sources: JSON.stringify(sources),
		conclusion: narrative.conclusion?.text || "",
		interviewNotes: narrative.interviewNotes || "N/A",
		violations: JSON.stringify(narrative.violations || []),
		classification: narrative.classification || "",
		accuserRoblox: narrative.accuserRoblox || "",
		title: row.created_via === "portal" ? "" : narrative.title,
		incidentAt: narrative.incidentTime,
		incidentLocation: narrative.incidentLocation,
		at: now()
	});
	if (narrative.accusedRank && row.subject_personnel_id) {
		db.prepare("UPDATE personnel SET rank = COALESCE(NULLIF(rank, ''), ?) WHERE id = ?").run(narrative.accusedRank, row.subject_personnel_id);
	}
}

function sourcesOf(narrative) {
	return {
		summary: narrative.summary.sources,
		interview: narrative.interview.sources,
		conclusion: narrative.conclusion?.sources || [],
		location: narrative.location.sources
	};
}

async function runDraft(caseId) {
	const row = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId);
	if (!row) return;
	db.prepare("UPDATE cases SET evidence = ? WHERE id = ?").run(mergeEvidence(row), caseId);
	const bundle = bundleFor(caseId);
	if (!bundle.length || !bundle.some(b => b.messages.length)) {
		db.prepare("UPDATE cases SET ai_state = 'failed', ai_error = ? WHERE id = ?").run("No ticket transcripts are linked to this case.", caseId);
		return;
	}
	db.prepare("UPDATE cases SET ai_state = 'drafting', ai_error = NULL WHERE id = ?").run(caseId);

	let output;
	try {
		output = await ai.draft({ bundle, punishments: punishments(), context: contextFor(row) });
	} catch (error) {
		const info = ai.providerInfo();
		db.prepare("INSERT INTO ai_drafts (case_id, created_at, provider, model, status, error) VALUES (?, ?, ?, ?, 'failed', ?)")
			.run(caseId, now(), info.provider, info.model, String(error.message).slice(0, 1000));
		throw error;
	}

	const draftId = db.prepare("INSERT INTO ai_drafts (case_id, created_at, provider, model, status, output, input_chars) VALUES (?, ?, ?, ?, 'ok', ?, ?)")
		.run(caseId, now(), output.provider, output.model, JSON.stringify(output), output.inputChars).lastInsertRowid;

	db.transaction(() => {
		const current = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId);
		const sources = sourcesOf(output.narrative);
		// Never overwrite what a human already edited. The new draft waits to be applied from the editor.
		if (current.narrative_human_edited) {
			db.prepare("UPDATE cases SET pending_draft_id = ? WHERE id = ?").run(draftId, caseId);
		} else {
			applyNarrative(caseId, output.narrative, sources);
		}
		const decision = output.decision;
		const signedAt = now();
		const hash = crypto.createHash("sha256").update(JSON.stringify({ caseId, decision, draftId })).digest("hex");
		const signature = `${AGENT_NAME} · ${output.provider}/${output.model} · recommendation only, not a finding`;
		db.prepare(`INSERT INTO ai_decisions (case_id, draft_id, finding, punishment, punishment_detail, appealable, rationale, signature, model, content_hash, signed_at, demo)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(caseId, draftId, decision.finding, decision.punishment, decision.punishmentDetail, decision.appealable ? 1 : 0,
				`${decision.rationale}${decision.confidence ? ` (Confidence: ${decision.confidence}.)` : ""}`, signature, output.model, hash, signedAt, current.demo);

		const nextStatus = ["under_investigation", "appealed"].includes(current.status) ? current.status : "marked_for_review";
		db.prepare("UPDATE cases SET ai_state = 'ready', ai_error = NULL, status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now(), caseId);
		audit.record({ name: AGENT_NAME }, "case.ai_draft", { type: "case", ref: current.ref }, {
			draftId, model: output.model, attempts: output.attempts, appliedNarrative: !current.narrative_human_edited
		});
		cases.indexCase(caseId);
	})();
}

function applyPendingDraft(ref, actor) {
	const row = cases.requireCase(ref);
	const perms = cases.casePermissions(actor, row);
	if (!perms.canEdit) throw cases.httpError(403, perms.recused ? `Recused: ${perms.recused}` : "You cannot edit this case");
	if (!row.pending_draft_id) throw cases.httpError(409, "There is no pending AI draft");
	const draft = db.prepare("SELECT * FROM ai_drafts WHERE id = ?").get(row.pending_draft_id);
	const output = json(draft?.output, null);
	if (!output) throw cases.httpError(409, "Draft is unavailable");
	applyNarrative(row.id, output.narrative, sourcesOf(output.narrative));
	audit.record(actor, "case.apply_ai_draft", { type: "case", ref: row.ref }, { draftId: draft.id });
	cases.indexCase(row.id);
}

let timer = null;
let busy = false;

async function tick() {
	if (busy) return;
	busy = true;
	try {
		const job = db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY id LIMIT 1").get(now());
		if (!job) return;
		db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now(), job.id);
		const payload = json(job.payload, {});
		try {
			if (job.kind === "draft_case") await runDraft(payload.caseId);
			db.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").run(now(), job.id);
		} catch (error) {
			const attempts = job.attempts + 1;
			const retry = error.retryable !== false && attempts < 5;
			db.prepare("UPDATE jobs SET status = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?")
				.run(retry ? "queued" : "failed", String(error.message).slice(0, 1000), now() + Math.min(30 * 60000, 30000 * 2 ** attempts), now(), job.id);
			if (payload.caseId) {
				db.prepare("UPDATE cases SET ai_state = ?, ai_error = ? WHERE id = ?")
					.run(retry ? "queued" : "failed", `${retry ? "Retrying: " : ""}${String(error.message).slice(0, 500)}`, payload.caseId);
			}
			console.warn(`[pipeline] job ${job.id} failed (attempt ${attempts}): ${error.message}`);
		}
	} finally {
		busy = false;
	}
}

function start() {
	// Jobs left running by a restart go back in the queue.
	db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run();
	db.prepare("UPDATE cases SET ai_state = 'queued' WHERE ai_state = 'drafting'").run();
	timer = setInterval(() => tick().catch(e => console.error("[pipeline]", e)), 4000);
	timer.unref?.();
}

function stop() {
	clearInterval(timer);
}

module.exports = { start, stop, tick, runDraft, applyPendingDraft, bundleFor, AGENT_NAME };
