import { h, clear, icon, api, toast, attempt, confirmDialog, statusPill, punishmentPicker } from "../lib.js";
import { store, can } from "../state.js";
import { openSignModal } from "./case.js";

export async function render({ params, page, go }) {
	const ref = params[0];
	const { case: c } = await api(`/cases/${encodeURIComponent(ref)}`);
	if (c.view !== "ia" || !c.permissions.canEdit) {
		const err = new Error(c.permissions?.recused ? `Recused: ${c.permissions.recused}` : "You cannot edit this case.");
		err.status = 403;
		throw err;
	}
	page.setTitle(`Edit case #${c.ref}`, c.title);
	page.setActions(h("a", { class: "btn ghost", href: `#/cases/${encodeURIComponent(c.ref)}` }, "Back to case file"));

	const decide = c.permissions.canDecide;
	const signed = c.signatureState !== "none";
	const personnel = (await api("/personnel")).personnel;

	const f = {
		title: h("input", { class: "input", value: c.title, maxlength: "140" }),
		kind: h("select", { class: "input", value: c.kind }, h("option", { value: "misconduct" }, "Misconduct"), h("option", { value: "ops" }, "OPS / system")),
		classification: h("input", { class: "input", value: c.classification, list: "ia-classifications" }),
		violations: h("input", { class: "input", value: c.violations.join(", "), placeholder: "Unprofessionalism, Reckless Driving" }),
		reporterRoblox: h("input", { class: "input", value: c.reporter.roblox || "", placeholder: "Reporter ROBLOX username", disabled: !c.reporter.revealed }),
		conclusion: h("textarea", { class: "input", rows: 6, value: c.report.conclusion }),
		interviewLocation: h("input", { class: "input", value: c.report.interviewLocation }),
		interviewPresent: h("input", { class: "input", value: c.report.interviewPresent }),
		interviewNotes: h("input", { class: "input", value: c.report.interviewNotes }),
		subject: h("select", { class: "input", value: c.subject ? String(c.subject.id) : "" }, h("option", { value: "" }, "No subject / unidentified"),
			personnel.map(p => h("option", { value: String(p.id) }, `${p.name}${p.callsign ? ` · ${p.callsign}` : ""}`))),
		incidentAt: h("input", { class: "input", value: c.incidentAt }),
		incidentLocation: h("input", { class: "input", value: c.incidentLocation }),
		summary: h("textarea", { class: "input", rows: 8, value: c.narrative.summary }),
		interview: h("textarea", { class: "input", rows: 6, value: c.narrative.interview }),
		location: h("textarea", { class: "input", rows: 3, value: c.narrative.location }),
		finding: h("select", { class: "input", value: c.final.finding || "" }, h("option", { value: "" }, "Not set"), store.policy.findings.map(x => h("option", { value: x.key }, x.label))),
		punishment: punishmentPicker(store.policy.punishments, c.final.punishment || "", keys => {
			f.appealable.value = keys.some(k => store.policy.punishments.find(p => p.key === k)?.appealable) ? "1" : "0";
		}),
		detail: h("input", { class: "input", value: c.final.punishmentDetail || "" }),
		appealable: h("select", { class: "input", value: c.final.appealable == null ? "" : c.final.appealable ? "1" : "0" }, h("option", { value: "" }, "Not set"), h("option", { value: "1" }, "Appealable"), h("option", { value: "0" }, "Not appealable")),
		notice: h("textarea", { class: "input", rows: 4, value: c.final.notice || "" }),
		reason: h("input", { class: "input", placeholder: signed ? "Required: why is signed content being changed?" : "Optional: reason for this edit" })
	};

	const selectedTags = new Set((c.tags || []).map(t => t.key));
	const tagPicker = h("div", { class: "role-list" }, (store.policy.tags || []).map(t => {
		const cb = h("input", { type: "checkbox", checked: selectedTags.has(t.key) });
		const chip = h("label", { class: `role-chip${cb.checked ? " on" : ""}` }, cb, h("span", { class: `label-chip ${t.color}` }, t.label));
		cb.addEventListener("change", () => { cb.checked ? selectedTags.add(t.key) : selectedTags.delete(t.key); chip.classList.toggle("on", cb.checked); });
		return chip;
	}));
	const evidence = c.report.evidence.map(item => ({ ...item }));
	const evBox = h("div", { class: "stack", style: { gap: "8px" } });
	function drawEvidence() {
		clear(evBox, evidence.map((item, i) => {
			const label = h("input", { class: "input", value: item.label, placeholder: "e.g. Roblox_User's Clip" });
			const url = h("input", { class: "input", value: item.url, placeholder: item.ref ? `Transcript ${item.ref}` : "https://medal.tv/..." });
			label.addEventListener("input", () => { item.label = label.value; });
			url.addEventListener("input", () => { item.url = url.value; });
			return h("div", { class: "tl-row" }, label, url,
				h("button", { class: "btn ghost sm", "aria-label": "Remove evidence", onclick: () => { evidence.splice(i, 1); drawEvidence(); } }, icon("x")));
		}), h("div", null, h("button", { class: "btn sm", onclick: () => { evidence.push({ label: "", url: "" }); drawEvidence(); } }, icon("plus"), "Add evidence link")));
	}
	drawEvidence();

	let timeline = c.narrative.timeline.map(item => ({ ...item }));
	const tlBox = h("div", { class: "stack", style: { gap: "10px" } });
	function drawTimeline() {
		clear(tlBox, timeline.map((item, i) => {
			const when = h("input", { class: "input", value: item.when, placeholder: "When" });
			const event = h("textarea", { class: "input", rows: 2, value: item.event, placeholder: "What happened" });
			when.addEventListener("input", () => { item.when = when.value; item.edited = true; });
			event.addEventListener("input", () => { item.event = event.value; item.edited = true; });
			return h("div", null, h("div", { class: "tl-row" }, when, event,
				h("button", { class: "btn ghost sm", title: "Remove entry", "aria-label": "Remove entry", onclick: () => { timeline.splice(i, 1); drawTimeline(); } }, icon("x"))),
				item.sources?.length ? h("div", { class: "sources-hint" }, `Sources: ${item.sources.join(", ")}${item.edited ? " · edited" : ""}`) : null);
		}), h("div", null, h("button", { class: "btn sm", onclick: () => { timeline.push({ when: "", event: "", sources: [], edited: true }); drawTimeline(); } }, icon("plus"), "Add timeline entry")));
	}
	drawTimeline();

	const pendingDraft = c.ai.pendingDraft ? h("div", { class: "stale-banner", style: { background: "rgba(160,124,242,.12)", borderColor: "rgba(160,124,242,.4)", color: "#d5c3ff" } }, icon("bot"),
		h("div", { class: "spacer" }, h("b", null, "A newer AI draft is available. "), "It was not applied automatically because this narrative has been edited by IA staff."),
		h("button", { class: "btn sm", onclick: async () => {
			const ok = await confirmDialog({ title: "Apply the new AI narrative?", message: "This replaces the summary, timeline, excerpts, interview and location sections with the new draft. Your edits remain in the edit history.", confirmLabel: "Apply draft" });
			if (!ok) return;
			await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/apply-draft`, { method: "POST", body: {} }), "AI draft applied");
			render({ params, page, go });
		} }, "Apply draft")) : null;

	const ticketInput = h("input", { class: "input", placeholder: "T-0012, T-0013" });
	const redraftAfter = h("input", { type: "checkbox", checked: true });

	clear(page.content, h("div", { class: "stack", dataset: { contained: "" } },
		h("div", { class: "row" }, statusPill(c.status), c.signatureState === "valid" ? h("span", { class: "tag green" }, icon("pen"), "Signed: edits to signed content will invalidate the signature") : null),
		pendingDraft,
		h("datalist", { id: "ia-classifications" }, (store.policy.classifications || []).map(x => h("option", { value: x }))),
		h("section", { class: "editor-section" }, h("h3", null, icon("file"), "Case header"),
			h("div", { class: "stack" },
				h("label", { class: "field" }, h("span", null, "Title (board card)"), f.title),
				h("div", { class: "grid-3" },
					h("label", { class: "field" }, h("span", null, "Case classification"), f.classification),
					h("label", { class: "field" }, h("span", null, "Type"), f.kind),
					h("label", { class: "field" }, h("span", null, "Accused trooper"), f.subject)),
				h("small", { class: "muted" }, "ROBLOX username, Discord username, and rank of the accused are edited on their personnel record (Users & Agents → Personnel directory)."),
				h("label", { class: "field" }, h("span", null, "Basis / accused violations (comma separated)"), f.violations),
				h("div", { class: "field" }, h("span", null, "Labels"), tagPicker),
				h("div", { class: "grid-3" },
					h("label", { class: "field" }, h("span", null, "Accuser ROBLOX username"), f.reporterRoblox),
					h("label", { class: "field" }, h("span", null, "Incident time"), f.incidentAt),
					h("label", { class: "field" }, h("span", null, "Incident location"), f.incidentLocation)))),
		h("section", { class: "editor-section" }, h("h3", null, icon("file"), "Investigation description ", h("span", { class: "tag violet" }, icon("bot"), "AI drafted, IA edited")),
			h("div", { class: "stack" },
				h("label", { class: "field" }, h("span", null, "Ticket Details"), f.summary),
				h("label", { class: "field" }, h("span", null, "Accused Trooper's Statement"), f.interview),
				h("label", { class: "field" }, h("span", null, "Conclusion"), f.conclusion))),
		h("section", { class: "editor-section" }, h("h3", null, icon("link"), "Investigation evidence"), evBox),
		h("section", { class: "editor-section" }, h("h3", null, icon("review"), "Investigation conclusion"),
			h("div", { class: "grid-3" },
				h("label", { class: "field" }, h("span", null, "Interview location"), f.interviewLocation),
				h("label", { class: "field" }, h("span", null, "Individuals present during interview"), f.interviewPresent),
				h("label", { class: "field" }, h("span", null, "Interview comments / notes"), f.interviewNotes)),
			h("small", { class: "muted" }, "Evidence support, punishment issued, closing date, and approver are filled in from the supervisor's signature.")),
		h("section", { class: "editor-section" }, h("h3", null, icon("search"), "Case analysis (supporting material)"),
			h("div", { class: "stack" },
				h("div", { class: "field" }, h("span", null, "Timeline"), tlBox),
				h("label", { class: "field" }, h("span", null, "In-game location details"), f.location),
				h("small", { class: "muted" }, "Ticket excerpts are verbatim quotes and cannot be edited."))),
		decide ? h("section", { class: "editor-section" }, h("h3", null, icon("scale"), "Supervisor determination (draft)"),
			h("div", { class: "stack" },
				h("div", { class: "grid-3" },
					h("label", { class: "field" }, h("span", null, "Finding"), f.finding),
					h("div", { class: "field" }, h("span", null, "Punishment(s)"), f.punishment.el),
					h("label", { class: "field" }, h("span", null, "Appealable"), f.appealable)),
				h("label", { class: "field" }, h("span", null, "Punishment detail"), f.detail),
				h("label", { class: "field" }, h("span", null, "Notice to member"), f.notice, h("small", null, "The only narrative the subject ever sees. Never include reporter details.")),
				h("small", { class: "muted" }, "These fields are a working draft. They become the decision of record when you sign."))) : null,
		h("section", { class: "editor-section" }, h("h3", null, icon("link"), "Link more tickets"),
			h("div", { class: "row" }, h("div", { style: { flex: "1 1 240px" } }, ticketInput), h("label", { class: "check" }, redraftAfter, "Redraft with AI afterwards"),
				h("button", { class: "btn", onclick: async () => {
					const refs = ticketInput.value.toUpperCase().match(/T-\d+/g) || [];
					if (!refs.length) return toast("Enter ticket references like T-0012", "error");
					const res = await attempt(() => api(`/cases/${encodeURIComponent(c.ref)}/tickets`, { method: "POST", body: { tickets: refs, redraft: redraftAfter.checked } }));
					toast(res.added.length ? `Linked ${res.added.join(", ")}` : "Those tickets were already linked");
					ticketInput.value = "";
				} }, icon("link"), "Link"))),
		h("div", { class: "sticky-save" },
			h("div", { style: { flex: "1 1 300px" } }, f.reason),
			h("a", { class: "btn ghost", href: `#/cases/${encodeURIComponent(c.ref)}` }, "Cancel"),
			h("button", { class: "btn primary", onclick: save }, icon("check"), "Save changes"),
			c.permissions.canSign ? h("button", { class: "btn", onclick: async () => { if (await save(true)) openSignModal((await api(`/cases/${encodeURIComponent(c.ref)}`)).case, () => go(`#/cases/${encodeURIComponent(c.ref)}`)); } }, icon("pen"), "Save & sign") : null)));

	async function save(stay) {
		const changes = {
			title: f.title.value,
			kind: f.kind.value,
			classification: f.classification.value,
			violations: f.violations.value.split(",").map(v => v.trim()).filter(Boolean),
			conclusion: f.conclusion.value,
			evidence,
			interview_location: f.interviewLocation.value,
			interview_present: f.interviewPresent.value,
			interview_notes: f.interviewNotes.value,
			subject_personnel_id: f.subject.value ? Number(f.subject.value) : null,
			incident_at: f.incidentAt.value,
			incident_location: f.incidentLocation.value,
			narrative_summary: f.summary.value,
			narrative_interview: f.interview.value,
			narrative_location: f.location.value,
			narrative_timeline: timeline
		};
		if (JSON.stringify(timeline) === JSON.stringify(c.narrative.timeline)) delete changes.narrative_timeline;
		if (JSON.stringify(changes.violations) === JSON.stringify(c.violations)) delete changes.violations;
		if (JSON.stringify(evidence) === JSON.stringify(c.report.evidence)) delete changes.evidence;
		const tagKeys = (store.policy.tags || []).map(t => t.key).filter(k => selectedTags.has(k));
		if (JSON.stringify(tagKeys) !== JSON.stringify((c.tags || []).map(t => t.key))) changes.tags = tagKeys;
		if (c.reporter.revealed) changes.reporter_roblox = f.reporterRoblox.value;
		if (decide) Object.assign(changes, {
			final_finding: f.finding.value || null,
			final_punishment: f.punishment.value() || null,
			final_punishment_detail: f.detail.value,
			final_appealable: f.appealable.value === "" ? null : f.appealable.value === "1",
			subject_notice: f.notice.value
		});
		try {
			const res = await api(`/cases/${encodeURIComponent(c.ref)}`, { method: "PATCH", body: { changes, reason: f.reason.value } });
			if (res.case.signatureState === "stale" && c.signatureState === "valid") toast("Saved. The signature no longer matches and the case returned to review.", "error");
			else toast("Case saved");
			if (stay !== true) go(`#/cases/${encodeURIComponent(c.ref)}`);
			return true;
		} catch (error) {
			toast(error.message, "error");
			return false;
		}
	}
}
