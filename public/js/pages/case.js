import { h, clear, icon, api, avatar, statusPill, fmtDate, ago, toast, attempt, modal, drawer, closeLayer, confirmDialog, redacted, watermark, punishmentPicker, STATUS } from "../lib.js";
import { store, can, findingLabel, punishmentLabel } from "../state.js";
import { refreshCounts } from "../app.js";

let current = null;

export async function render({ params, page, go }) {
	const ref = params[0];
	const data = await api(`/cases/${encodeURIComponent(ref)}`);
	const c = data.case;
	current = c;
	if (c.view === "subject") {
		go("#/my");
		return;
	}
	page.setTitle(`Case #${c.ref}`, c.subjectLine || c.title);
	const actions = [];
	if (c.permissions.canExport) actions.push(h("a", { class: "btn", href: `api/cases/${encodeURIComponent(c.ref)}/export.pdf`, download: `SAHP-IA-Case-${c.ref}.pdf`, title: "Export the Investigation Report as PDF (logged)" }, icon("file"), "Download PDF"));
	if (c.permissions.canEdit) actions.push(h("a", { class: "btn", href: `#/cases/${encodeURIComponent(c.ref)}/edit` }, icon("edit"), "Edit case"));
	if (c.permissions.canSign) actions.push(h("button", { class: "btn primary", onclick: () => openSignModal(c, reload) }, icon("pen"), "Sign & approve"));
	page.setActions(...actions);

	const reload = () => render({ params, page, go });
	clear(page.content, h("div", { class: "case-layout" }, caseFile(c), sidebar(c, reload)));
}

// ---------- Main case file ------------------------------------------------------------

function caseFile(c) {
	const wrap = h("div", { class: "stack", style: { gap: "16px" } });
	const status = h("div", { class: "row" }, statusPill(c.status),
		c.kind === "ops" ? h("span", { class: "tag blue" }, "OPS / system") : null,
		c.anonymous || c.reporter.anonymous ? h("span", { class: "tag red" }, icon("lock"), "Anonymous report: hidden from the accused") : null,
		c.signatureState === "valid" ? h("span", { class: "tag green" }, icon("pen"), "Signed") : null,
		c.signatureState === "stale" ? h("span", { class: "tag red" }, icon("alert"), "Signature invalidated") : null,
		c.demo ? h("span", { class: "tag" }, "Demo data") : null,
		...(c.tags || []).map(t => h("span", { class: `label-chip ${t.color}` }, t.label)),
		c.related.length ? h("span", { class: "tag gold" }, icon("link"), `Related: ${c.related.map(r => `#${r.ref}`).join(", ")}`) : null);

	const review = h("article", { class: "casefile", dataset: { contained: "" } },
		h("div", { class: "section" }, status),
		c.legacy ? legacySection(c) : decisionSection(c),
		watermark());

	wrap.append(review, investigationReport(c), analysis(c));
	return wrap;
}

// Records imported from the Trello board: no AI draft or portal signature, but the original determination.
function legacySection(c) {
	return h("section", { class: "section" },
		h("h3", { class: "section-title" }, icon("file"), "Imported investigation record"),
		h("div", { class: "legacy-banner" }, icon("log"),
			h("div", { class: "stack", style: { gap: "4px" } },
				h("div", null, "This case was concluded before the portal and imported from the IA Trello board. It is read-only."),
				c.report.punishmentsIssued ? h("div", null, h("b", null, "Issued punishment: "), c.report.punishmentsIssued) : null,
				c.report.punishmentNotes ? h("div", null, h("b", null, "Notes: "), c.report.punishmentNotes) : null,
				c.legacy.docUrl ? h("div", null, h("a", { href: c.legacy.docUrl, target: "_blank", rel: "noopener noreferrer" }, icon("link"), " Open the original Google Doc report")) : null)));
}

function kv(label, value) {
	return h("div", { class: "kv" }, h("span", null, `${label}:`), h("b", null, value || h("span", { class: "muted" }, "-")));
}

function withCites(text, refs, fallback) {
	return h("div", null, h("div", { class: `prose${text ? "" : " empty-text"}` }, text || fallback), refs?.length ? h("div", { class: "cite-row" }, h("span", { class: "muted small" }, "Sources"), cites(refs)) : null);
}

// Mirrors the Office of Professional Standards "Investigation Report" layout.
function investigationReport(c) {
	const s = c.subject;
	const r = c.reporter;
	const rp = c.report;
	const n = c.narrative;
	const reportDate = c.closedAt || c.approvedAt || c.createdAt;
	const reportDateText = rp.reportDate || fmtDate(reportDate, false);
	const evidence = rp.evidence.length ? h("ul", { class: "evidence" }, rp.evidence.map(e => h("li", null,
		e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, icon("link"), e.label) : h("span", null, icon("file"), e.label),
		e.ref ? h("button", { class: "cite", onclick: () => openTranscript(current, e.ref) }, e.ref) : null)))
		: h("div", { class: "prose empty-text" }, "No evidence listed.");

	return h("article", { class: "report", dataset: { contained: "" } },
		h("header", { class: "letterhead" },
			h("div", { class: "lh-date" }, reportDateText),
			h("img", { src: "img/ia-seal.png", alt: "" }),
			h("div", { class: "lh-org" },
				h("b", null, "The Office of Professional Standards"),
				h("span", null, "Division of Internal Affairs"),
				h("span", null, "San Andreas Highway Patrol"),
				h("span", { class: "muted" }, "Sandy Shores, BC, San Andreas"),
				h("span", { class: "muted" }, "Law Way, P.O. BOX 60597"))),
		h("h2", { class: "report-title" }, "Investigation Report"),
		h("div", { class: "kv-list" },
			kv("Case", h("span", { class: "mono" }, `#${c.ref}`)),
			kv("Investigator(s) Name(s)", c.investigators.join(", ") || "Unassigned"),
			kv("Case Classification", c.classification),
			kv("Accused Violations", c.violations.length ? c.violations.join(", ") : null)),
		h("div", { class: "contact-grid" },
			h("section", null, h("h4", null, "Accused Trooper Contact Information"),
				s ? [kv("ROBLOX Username", s.roblox), kv("Discord Username", s.discordUsername), kv("Rank", s.rank), kv("Department", s.department)]
					: h("div", { class: "muted" }, c.kind === "ops" ? "Not applicable" : "Unidentified")),
			h("section", null, h("h4", null, "Accuser Contact Information", r.anonymous ? h("span", { class: "tag red" }, "Anonymous") : null),
				r.revealed ? [kv("ROBLOX Username", r.roblox), kv("Discord Username", r.username || r.name), r.anonymous ? h("small", { class: "muted" }, "Filed anonymously. Never shown to the accused.") : null]
					: redacted("Anonymous"))),
		h("div", { class: "fouo" }, "Confidential / For Official Use Only (FOUO)"),
		h("h3", { class: "report-h" }, "Investigation Description"),
		h("h4", { class: "report-sub" }, "Ticket Details", c.legacy ? h("span", { class: "tag" }, icon("file"), "Original report") : n.humanEdited ? h("span", { class: "tag" }, icon("edit"), "Edited") : h("span", { class: "tag violet" }, icon("bot"), "AI drafted")),
		withCites(n.summary, n.sources.summary, "Not drafted yet."),
		h("h4", { class: "report-sub" }, "Accused Trooper's Statement"),
		withCites(n.interview, n.sources.interview, "No statement recorded."),
		h("h4", { class: "report-sub" }, "Conclusion"),
		withCites(rp.conclusion, n.sources.conclusion, "No conclusion yet."),
		h("h3", { class: "report-h" }, "Investigation Evidence"),
		evidence,
		h("h3", { class: "report-h" }, "Investigation Conclusion"),
		h("div", { class: "kv-list" },
			kv("Interview Location", rp.interviewLocation),
			kv("Individuals Present During Interview", rp.interviewPresent),
			kv("Interview Comments / Notes", rp.interviewNotes),
			kv("Does the evidence support the allegation(s)", rp.evidenceSupports),
			kv("Punishment(s) Issued", rp.punishmentsIssued || (c.final.punishmentLabel ? `${c.final.punishmentLabel} (draft, unsigned)` : null)),
			kv("Date Investigation Was Closed", rp.closedDate || (c.closedAt ? fmtDate(c.closedAt, false) : null)),
			rp.punishmentNotes ? kv("Punishment Notes", rp.punishmentNotes) : null,
			kv("Investigation Approved & Processed By", rp.processedBy ? h("span", { class: "sig-inline" }, rp.processedBy) : null)),
		c.legacy?.extra ? [h("h3", { class: "report-h" }, "Additional Record Notes"), h("div", { class: "prose" }, c.legacy.extra)] : null,
		h("div", { class: "fouo" }, "Confidential / For Official Use Only (FOUO)"),
		watermark());
}

function analysis(c) {
	return h("article", { class: "casefile", dataset: { contained: "" } },
		h("div", { class: "section" }, h("h3", { class: "section-title" }, icon("search"), "Case analysis",
			h("span", { class: "tag" }, "Supporting material, not part of the report"))),
		...narrativeSections(c).filter(Boolean),
		watermark());
}

function fact(label, value) {
	return h("div", { class: "fact" }, h("label", null, label), h("div", null, value));
}

function cites(refs) {
	if (!refs?.length) return null;
	return h("span", { class: "cites" }, refs.map(ref => h("button", { class: "cite", title: `Open ${ref} in the transcript`, onclick: () => openTranscript(current, ref) }, ref)));
}

function decisionSection(c) {
	const ai = c.ai.decision;
	const sig = c.signatures[0];
	const aiCard = h("div", { class: "decision ai" },
		h("h4", null, icon("bot"), "AI recommendation", h("span", { class: "tag" }, "Advisory only")),
		ai ? [
			h("dl", null,
				h("dt", null, "Finding"), h("dd", null, findingLabel(ai.finding)),
				h("dt", null, "Punishment"), h("dd", null, ai.punishmentLabel, ai.punishmentDetail ? h("div", { class: "muted small" }, ai.punishmentDetail) : null),
				h("dt", null, "Appealable"), h("dd", null, ai.appealable ? "Yes" : "No")),
			h("div", { class: "rationale" }, ai.rationale),
			h("div", { class: "sigblock" },
				h("div", null, icon("bot"), " ", ai.signature),
				h("div", null, `Signed ${fmtDate(ai.signedAt)}`),
				h("div", { class: "hash" }, `sha256 ${ai.hash.slice(0, 32)}…`))
		] : h("div", { class: "muted" }, c.ai.state === "queued" || c.ai.state === "drafting"
			? "The drafting agent is working on this case."
			: c.ai.state === "failed" ? `Drafting failed: ${c.ai.error || "unknown error"}` : "No AI recommendation for this case."));

	const humanCard = h("div", { class: `decision human${c.signatureState === "stale" ? " stale" : ""}` },
		h("h4", null, icon("scale"), "Supervisor determination"),
		c.final.punishment || sig ? h("dl", null,
			h("dt", null, "Finding"), h("dd", null, findingLabel(c.final.finding)),
			h("dt", null, "Punishment"), h("dd", null, c.final.punishmentLabel || "-", c.final.punishmentDetail ? h("div", { class: "muted small" }, c.final.punishmentDetail) : null),
			h("dt", null, "Appealable"), h("dd", null, c.final.appealable == null ? "-" : c.final.appealable ? "Yes" : "No")) : h("div", { class: "muted" }, "No determination yet."),
		c.final.notice ? h("div", { class: "rationale" }, h("b", null, "Notice to member: "), c.final.notice) : null,
		sig ? h("div", { class: "sigblock" },
			h("div", { class: "sig" }, sig.signerName),
			h("div", null, [sig.signerTitle, `Signed ${fmtDate(sig.signedAt)}`].filter(Boolean).join(" · ")),
			sig.statement ? h("div", { style: { marginTop: "4px" } }, `“${sig.statement}”`) : null,
			h("div", { class: "hash" }, `sha256 ${sig.hash.slice(0, 32)}…`))
			: h("div", { class: "sigblock" }, h("div", { class: "muted" }, "Awaiting supervisor signature")));

	return h("section", { class: "section" },
		h("h3", { class: "section-title" }, icon("scale"), "Decision"),
		c.signatureState === "stale" ? h("div", { class: "stale-banner" }, icon("alert"),
			h("div", null, h("b", null, "Signed content has changed. "), "The case was edited after the supervisor signed it. The signature below no longer matches the case file and the case must be re-signed before it can close.")) : null,
		h("div", { class: "decision-grid" }, aiCard, humanCard),
		c.signatures.length > 1 ? h("details", { style: { marginTop: "12px" } }, h("summary", { class: "muted small" }, `${c.signatures.length - 1} earlier signature(s)`),
			c.signatures.slice(1).map(s => h("div", { class: "note", style: { marginTop: "8px" } },
				h("header", null, h("b", null, s.signerName), h("span", null, fmtDate(s.signedAt))),
				h("p", null, `${findingLabel(s.finding)} · ${s.punishmentLabel}${s.punishmentDetail ? ` (${s.punishmentDetail})` : ""} · ${s.appealable ? "appealable" : "not appealable"}${s.stale ? " · superseded" : ""}`)))) : null);
}

function narrativeSections(c) {
	const n = c.narrative;
	const prose = (text, fallback) => h("div", { class: `prose${text ? "" : " empty-text"}` }, text || fallback);
	return [
		h("section", { class: "section" },
			h("h3", { class: "section-title" }, icon("clock"), "Timeline"),
			n.timeline.length ? h("ul", { class: "timeline" }, n.timeline.map(item => h("li", null,
				h("div", { class: "when" }, item.when || "Unspecified", item.edited ? h("span", { class: "muted small" }, "  (edited)") : null),
				h("div", { class: "what" }, item.event, cites(item.sources))))) : prose("", "No timeline recorded.")),
		n.excerpts.length ? h("section", { class: "section" },
			h("h3", { class: "section-title" }, icon("quote"), "Ticket excerpts"),
			n.excerpts.map(e => h("blockquote", { class: "quote" }, h("p", null, e.quote),
				h("footer", null, h("b", null, e.speaker || "-"), cites([e.ref]), e.relevance ? h("span", null, `· ${e.relevance}`) : null)))) : null,
		h("section", { class: "section" },
			h("h3", { class: "section-title" }, icon("pin"), "In-game location"),
			h("div", { class: "muted small", style: { marginBottom: "6px" } }, [c.incidentAt, c.incidentLocation].filter(Boolean).join(" · ")),
			prose(n.location, "No location details."), cites(n.sources.location)),
		c.related.length ? h("section", { class: "section" },
			h("h3", { class: "section-title" }, icon("link"), "Related cases (same tickets)"),
			h("div", { class: "stack", style: { gap: "6px" } }, c.related.map(r => h("a", { href: `#/cases/${r.ref}` }, `#${r.ref} · ${r.title}`)))) : null
	];
}

// ---------- Sidebar -------------------------------------------------------------------

function sidebar(c, reload) {
	const p = c.permissions;
	const actions = h("div", { class: "action-list" });
	if (p.ownerOverride) actions.append(h("div", { class: "note small" }, h("b", null, "Owner override. "), "You are the accused or the reporting party here. Conflict-of-interest rules are bypassed for your account, and your actions on this case are flagged in the audit log."));
	if (p.recused) actions.append(h("div", { class: "recused" }, h("b", null, "Recused. "), p.recused, " You can read this file but cannot act on it."));
	if (p.locked) actions.append(h("div", { class: "muted small" }, icon("lock"), " Closed and locked. Only the Head of IA can reopen it on appeal."));
	for (const t of p.transitions) {
		if (t.requiresSignature) continue;
		actions.append(h("button", { class: "btn", onclick: () => moveTo(c, t.to, reload) }, icon("move"), `Move to ${t.label}`));
	}
	if (p.canAssign) actions.append(h("button", { class: "btn", onclick: () => assignModal(c, reload) }, icon("user"), c.assignedAgent ? "Reassign agent" : "Assign agent"));
	if (p.canRedraft && c.tickets.length) actions.append(h("button", { class: "btn", onclick: async () => {
		const ok = await confirmDialog({ title: "Redraft with AI?", message: c.narrative.humanEdited
			? "A fresh AI draft will be produced. Because this narrative was edited by IA, the new draft will wait in the editor for you to apply. A new AI recommendation will be recorded." : "The drafting agent will rewrite the narrative from the linked transcripts and record a new recommendation.", confirmLabel: "Redraft" });
		if (!ok) return;
		await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/redraft`, { method: "POST", body: {} }), "Queued for AI drafting");
		reload();
	} }, icon("bot"), "Redraft with AI"));
	if (p.canViewHistory) actions.append(h("button", { class: "btn", onclick: () => openHistory(c) }, icon("log"), "Case history & audit"));
	if (p.canDelete) actions.append(h("button", { class: "btn danger", onclick: async () => {
		const typed = await confirmDialog({
			title: `Delete case #${c.ref}?`,
			message: "Owner-only cleanup for unsigned cases such as tests. The case is removed permanently, its tickets return to the inbox, and the deletion is recorded in the audit log. Signed cases can never be deleted.",
			confirmLabel: "Delete case",
			danger: true,
			input: { label: `Type DELETE ${c.ref} to confirm`, required: true }
		});
		if (!typed) return;
		await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}`, { method: "DELETE", body: { confirm: typed.trim(), reason: "Deleted from case file" } }), `Case #${c.ref} deleted`);
		refreshCounts();
		location.hash = "#/board";
	} }, icon("x"), "Delete case (owner)"));

	const ticketList = h("div", { class: "stack", style: { gap: "8px" } }, c.tickets.length ? c.tickets.map(t =>
		h("div", { class: "ticket-item", role: "button", tabindex: "0", onclick: () => openTranscript(c, `${t.ref}#1`, false), onkeydown: e => { if (e.key === "Enter") openTranscript(c, `${t.ref}#1`, false); } },
			h("span", { class: "ref" }, t.ref),
			h("div", { style: { minWidth: 0, flex: 1 } },
				h("div", { class: "small" }, t.type === "report" ? "Trooper report" : t.type === "interview" ? "Interview" : "OPS report", t.anonymous ? h("span", { class: "tag red", style: { marginLeft: "6px" } }, "Anon") : null),
				h("div", { class: "muted small" }, `${t.messageCount} messages · ${t.status === "closed" ? `closed ${ago(t.closedAt)}` : "open"}`)),
			icon("eye"))) : h("div", { class: "muted small" }, "No tickets linked."));

	const noteInput = h("textarea", { class: "input", placeholder: "Add an internal note for IA staff…", rows: 3 });
	noteInput.style.minHeight = "70px";
	const notes = h("div", { class: "stack", style: { gap: "8px" }, dataset: { contained: "" } },
		c.notes.length ? c.notes.map(n => h("div", { class: "note" }, h("header", null, h("b", null, n.author_name), h("span", null, ago(n.created_at))), h("p", null, n.body)))
			: h("div", { class: "muted small" }, "No notes yet."));

	return h("aside", { class: "side" },
		h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", null, "Actions")), h("div", { class: "panel-body" }, actions.childElementCount ? actions : h("div", { class: "muted small" }, "No actions available."))),
		h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", null, "Evidence · linked tickets")), h("div", { class: "panel-body" }, ticketList)),
		keyPointsPanel(c, reload),
		h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", null, "Investigator notes")), h("div", { class: "panel-body stack" }, notes,
			p.canNote ? h("div", { class: "stack", style: { gap: "8px" } }, noteInput, h("button", { class: "btn sm", onclick: async () => {
				if (!noteInput.value.trim()) return;
				await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/notes`, { method: "POST", body: { body: noteInput.value } }), "Note added");
				reload();
			} }, "Add note")) : null)),
		c.appeals.length ? h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", null, "Appeals")), h("div", { class: "panel-body stack", dataset: { contained: "" } },
			c.appeals.map(a => h("div", { class: "note" }, h("header", null, h("b", null, a.status.toUpperCase()), h("span", null, ago(a.created_at))), h("p", null, a.reason))))) : null);
}

// Key points: short facts from the investigating officer that the AI must build the report on.
function keyPointsPanel(c, reload) {
	const editable = c.permissions.canEdit && !c.legacy;
	let points = (c.keyPoints || []).map(p => ({ ...p }));
	const list = h("ul", { class: "key-points", dataset: { contained: "" } });
	const input = h("textarea", { class: "input", rows: 2, placeholder: "Add a key point, e.g. \"Accused admitted in T-0012 that he fired first\" or \"Reporter's clip shows 110 MPH on the HUD\"" });
	input.style.minHeight = "56px";
	const save = async next => {
		const res = await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/key-points`, { method: "POST", body: { points: next.map(p => p.text) } }));
		points = res.keyPoints;
		draw();
	};
	function draw() {
		clear(list, points.length ? points.map((p, i) => h("li", null,
			h("span", null, p.text),
			editable ? h("button", { class: "btn ghost sm", "aria-label": "Remove key point", onclick: () => save(points.filter((_, k) => k !== i)) }, icon("x")) : h("span"),
			h("span", { class: "meta" }, `${p.author || "IA"} · ${ago(p.at)}`)))
			: h("li", { class: "muted small" }, h("span", null, editable ? "No key points yet. Add the facts the report must cover; the AI will use every one." : "No key points.")));
	}
	draw();
	return h("div", { class: "panel" },
		h("div", { class: "panel-head" }, h("h3", null, "Key points for the report")),
		h("div", { class: "panel-body stack" }, list,
			editable ? h("div", { class: "stack", style: { gap: "8px" } }, input,
				h("div", { class: "row" },
					h("button", { class: "btn sm", onclick: async () => {
						const text = input.value.trim();
						if (!text) return;
						await save([...points, { text }]);
						input.value = "";
					} }, icon("plus"), "Add key point"),
					c.permissions.canRedraft && c.tickets.length ? h("button", { class: "btn sm ghost", title: "Redraft the report using these key points", onclick: async () => {
						await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/redraft`, { method: "POST", body: {} }), "Queued for AI drafting with your key points");
						reload();
					} }, icon("bot"), "Redraft with key points") : null)) : null));
}

async function moveTo(c, to, reload) {
	const needsNote = ["under_investigation", "appealed"].includes(to);
	const note = await confirmDialog({
		title: `Move to ${STATUS[to].label}?`,
		message: to === "closed" ? "Closing locks the case file permanently. Only the Head of IA can reopen it on appeal." : "Record a note for the case file.",
		confirmLabel: "Move case",
		input: { label: needsNote ? "Note (required)" : "Note (optional)", multiline: true, required: needsNote }
	});
	if (note === null) return;
	await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/status`, { method: "POST", body: { to, note: note === true ? "" : note } }), `Moved to ${STATUS[to].label}`);
	refreshCounts();
	reload();
}

async function assignModal(c, reload) {
	const { agents } = await api("/agents");
	const select = h("select", { class: "input", value: c.assignedAgent?.id || "" }, h("option", { value: "" }, "Unassigned"),
		agents.filter(a => a.id !== c.subject?.discordId).map(a => h("option", { value: a.id }, `${a.name}${a.callsign ? ` (${a.callsign})` : ""}`)));
	modal({
		title: `Assign case #${c.ref}`,
		body: h("label", { class: "field" }, h("span", null, "Investigating agent"), select),
		actions: [
			h("button", { class: "btn ghost", onclick: closeLayer }, "Cancel"),
			h("button", { class: "btn primary", onclick: async () => {
				await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/assign`, { method: "POST", body: { agentId: select.value || null } }), "Assignment saved");
				closeLayer();
				reload();
			} }, "Save")
		]
	});
}

// ---------- Signing ----------------------------------------------------------------------

export function openSignModal(c, onDone) {
	const ai = c.ai.decision;
	const findings = store.policy.findings;
	const punishments = store.policy.punishments;
	const finding = h("select", { class: "input", value: c.final.finding || ai?.finding || "" }, h("option", { value: "" }, "Select finding…"), findings.map(f => h("option", { value: f.key }, f.label)));
	const diff = h("div", { class: "muted small" });
	const picker = punishmentPicker(punishments, c.final.punishment || ai?.punishment || "", keys => {
		appealable.checked = keys.some(k => punishments.find(p => p.key === k)?.appealable);
		updateDiff();
	});
	const detail = h("input", { class: "input", value: c.final.punishmentDetail || ai?.punishmentDetail || "", placeholder: "e.g. X1 Black Mark, 7 days, demoted to TPR" });
	const appealable = h("input", { type: "checkbox", checked: c.final.appealable ?? ai?.appealable ?? false });
	const notice = h("textarea", { class: "input", value: c.final.notice || "", placeholder: "What the member will see in their IA record. Do not include reporter details." });
	const statement = h("input", { class: "input", placeholder: "Optional: basis for the decision (internal)" });
	const typed = h("input", { class: "input", placeholder: store.me.displayName, autocomplete: "off" });
	function updateDiff() {
		diff.textContent = ai && (picker.value() !== ai.punishmentKeys.join(",") || finding.value !== ai.finding)
			? `Differs from AI recommendation (${findingLabel(ai.finding)} · ${ai.punishmentLabel}). That's fine: your determination is the one of record.` : "";
	}
	finding.addEventListener("change", updateDiff);
	updateDiff();

	modal({
		title: `Sign & approve case #${c.ref}`,
		wide: true,
		contained: true,
		body: h("div", { class: "stack" },
			h("label", { class: "field" }, h("span", null, "Finding (does the evidence support the allegations?)"), finding),
			h("div", { class: "field" }, h("span", null, "Punishment(s) issued"), picker.el),
			h("label", { class: "field" }, h("span", null, "Punishment detail"), detail),
			h("label", { class: "check" }, appealable, "This decision is appealable"),
			diff,
			h("label", { class: "field" }, h("span", null, "Notice to member"), notice, h("small", null, "Shown to the subject in their IA record once approved. The AI rationale and narrative are never shown to them.")),
			h("label", { class: "field" }, h("span", null, "Statement"), statement),
			h("div", { class: "stale-banner", style: { background: "var(--gold-soft)", borderColor: "var(--gold-line)", color: "var(--gold-2)" } }, icon("pen"),
				h("div", null, "Your signature is recorded with a timestamp and a hash of the case file. It cannot be edited or removed. Any later edit to the signed content flags the signature and sends the case back for review.")),
			h("label", { class: "field" }, h("span", null, `Type your name exactly (${store.me.displayName}) to sign`), typed)),
		actions: [
			h("button", { class: "btn ghost", onclick: closeLayer }, "Cancel"),
			h("button", { class: "btn primary", onclick: async () => {
				await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/sign`, { method: "POST", body: {
					finding: finding.value, punishment: picker.value(), punishmentDetail: detail.value, appealable: appealable.checked,
					notice: notice.value, statement: statement.value, typedName: typed.value
				} }), `${c.ref} signed and approved`);
				closeLayer();
				refreshCounts();
				onDone?.();
			} }, icon("pen"), "Sign & approve")
		]
	});
}

// ---------- Transcript drawer ----------------------------------------------------------------

export async function openTranscript(c, citeRef, highlight = true) {
	const [ticketRef, seq] = String(citeRef).split("#");
	const body = drawer({ title: `Transcript ${ticketRef}`, subtitle: `Case #${c.ref} · read-only · access logged`, body: h("div", { class: "skeleton", style: { height: "200px" } }), watermarkFor: { name: store.me.displayName, id: store.me.id } });
	try {
		const data = await api(`/cases/${encodeURIComponent(c.ref)}/transcripts/${encodeURIComponent(ticketRef)}`);
		renderTranscript(body, data, highlight ? Number(seq) : null);
	} catch (error) {
		clear(body, h("div", { class: "empty" }, error.message));
	}
}

export function renderTranscript(body, data, highlightSeq, attachmentBase = "api/attachments/") {
	const intake = Object.entries(data.intake || {});
	const list = data.messages.map(m => {
		const el = h("div", { class: `msg${m.authorRole === "bot" ? " bot" : ""}${m.seq === highlightSeq ? " hl" : ""}`, id: `msg-${m.seq}` },
			avatar(m.author, m.avatar),
			h("div", null,
				h("header", null, h("b", { class: m.authorRole === "reporter" ? "role-reporter" : "" }, m.author), h("span", { class: "seq" }, m.ref), h("time", null, fmtDate(m.createdAt))),
				h("div", { class: "body" }, m.content || h("span", { class: "muted" }, "(no text)")),
				m.attachments.map(a => h("div", { class: "attach" },
					/^image\//.test(a.contentType || "") ? h("img", { src: `${attachmentBase}${a.id}`, alt: a.filename, loading: "lazy" })
						: /^video\//.test(a.contentType || "") ? h("video", { src: `${attachmentBase}${a.id}`, controls: true, controlsList: "nodownload noplaybackrate", disablePictureInPicture: true })
						: h("span", { class: "tag" }, icon("file"), a.filename)))));
		return el;
	});
	clear(body,
		intake.length ? h("div", { class: "intake" }, h("div", { class: "eyebrow", style: { marginBottom: "6px" } }, "Intake form"),
			intake.map(([k, v]) => h("div", null, h("b", null, `${k.replace(/([A-Z])/g, " $1")}: `), v))) : null,
		data.messages.length ? list : h("div", { class: "empty" }, "No messages captured."),
		watermark());
	if (highlightSeq) setTimeout(() => body.querySelector(`#msg-${highlightSeq}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
}

// ---------- History --------------------------------------------------------------------------

async function openHistory(c) {
	const body = drawer({ title: `History · case #${c.ref}`, subtitle: "Edits, status changes, signatures, views", body: h("div", { class: "skeleton", style: { height: "200px" } }) });
	const data = await api(`/cases/${encodeURIComponent(c.ref)}/history`);
	const label = a => ({
		"case.view": "Viewed", "case.edit": "Edited", "case.status": "Status change", "case.sign": "Signed", "case.create": "Created",
		"case.ai_draft": "AI draft", "case.assign": "Assigned", "case.note": "Note", "case.link_tickets": "Tickets linked", "case.redraft": "Redraft requested",
		"case.apply_ai_draft": "AI draft applied", "case.appeal_request": "Appeal requested"
	})[a] || a;
	clear(body,
		h("h4", { class: "eyebrow" }, "Activity"),
		h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("tbody", null, data.events.map(e => h("tr", null,
			h("td", { class: "muted small", style: { whiteSpace: "nowrap" } }, fmtDate(e.at)),
			h("td", null, h("b", null, e.actor_name)),
			h("td", null, label(e.action), h("div", { class: "muted small" }, summarizeDetail(e.action, e.detail)))))))),
		data.edits.length ? [h("h4", { class: "eyebrow", style: { marginTop: "20px" } }, "Field edits"),
			data.edits.map(e => h("div", { class: "note", style: { marginBottom: "8px" } },
				h("header", null, h("b", null, `${e.editor_name} · ${e.field.replace(/_/g, " ")}`), h("span", null, fmtDate(e.created_at))),
				e.reason ? h("p", { class: "muted" }, `Reason: ${e.reason}`) : null,
				h("p", { class: "small" }, h("span", { class: "muted" }, "Before: "), truncate(e.before)),
				h("p", { class: "small" }, h("span", { class: "muted" }, "After: "), truncate(e.after))))] : null,
		data.drafts.length ? [h("h4", { class: "eyebrow", style: { marginTop: "20px" } }, "AI drafts"),
			data.drafts.map(d => h("div", { class: "muted small" }, `#${d.id} · ${fmtDate(d.created_at)} · ${d.provider}/${d.model} · ${d.status}${d.error ? ` · ${d.error}` : ""}`))] : null);
}

function truncate(text) {
	const s = String(text ?? "-");
	return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

function summarizeDetail(action, d) {
	if (!d) return "";
	if (action === "case.status") return `${STATUS[d.from]?.label || d.from} → ${STATUS[d.to]?.label || d.to}${d.note ? ` · ${d.note}` : ""}${d.auto ? ` · automatic: ${d.auto}` : ""}`;
	if (action === "case.edit") return `${(d.fields || []).join(", ")}${d.reason ? ` · reason: ${d.reason}` : ""}${d.signature === "invalidated" ? " · signature invalidated" : ""}`;
	if (action === "case.sign") return `${findingLabel(d.finding)} · ${punishmentLabel(d.punishment)}`;
	if (action === "case.view") return d.view === "subject" ? "member view" : "";
	if (action === "case.link_tickets") return (d.tickets || []).join(", ");
	return "";
}
