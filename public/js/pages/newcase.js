import { h, clear, icon, api, toast, ago, punishmentPicker } from "../lib.js";
import { store, can } from "../state.js";

export async function render({ page, go }) {
	page.setTitle("New Case", "Assemble a case from one or more tickets. Anonymous reports and interview tickets merge here.");
	const preselect = new Set((new URLSearchParams(location.hash.split("?")[1] || "").get("tickets") || "").split(",").filter(Boolean));
	const [{ tickets }, { personnel }, { agents }] = await Promise.all([api("/tickets?state=all"), api("/personnel"), api("/agents")]);
	const selected = new Set([...preselect].filter(ref => tickets.some(t => t.ref === ref)));
	const decide = can("case.decide");

	const filter = h("input", { class: "input", type: "search", placeholder: "Filter tickets by ref, trooper, allegation…" });
	const showAttached = h("input", { type: "checkbox" });
	const ticketBox = h("div", { class: "table-wrap" });
	const summaryLine = h("div", { class: "muted small" });

	function drawTickets() {
		const needle = filter.value.trim().toLowerCase();
		const rows = tickets.filter(t => (showAttached.checked || !t.caseRef || selected.has(t.ref)) && (!needle || [t.ref, t.subject, t.opener, t.allegation].some(v => String(v || "").toLowerCase().includes(needle))));
		clear(ticketBox, rows.length ? h("table", { class: "table" },
			h("thead", null, h("tr", null, ["", "Ticket", "Type", "Subject", "Allegation", "Status"].map(x => h("th", null, x)))),
			h("tbody", null, rows.map(t => {
				const box = h("input", { type: "checkbox", checked: selected.has(t.ref), "aria-label": `Select ${t.ref}` });
				box.addEventListener("change", () => { box.checked ? selected.add(t.ref) : selected.delete(t.ref); updateSummary(); });
				return h("tr", { class: "clickable", onclick: e => { if (e.target !== box) { box.checked = !box.checked; box.dispatchEvent(new Event("change")); } } },
					h("td", null, box),
					h("td", { class: "mono", style: { color: "var(--gold)" } }, t.ref),
					h("td", null, t.typeLabel, t.anonymous ? h("span", { class: "tag red", style: { marginLeft: "6px" } }, icon("lock"), "Anon") : null),
					h("td", null, t.subject || h("span", { class: "muted" }, "-")),
					h("td", { class: "small" }, t.allegation || h("span", { class: "muted" }, "-")),
					h("td", { class: "small" }, t.caseRef ? h("span", { class: "tag gold" }, `In #${t.caseRef}`) : t.status === "open" ? h("span", { class: "tag blue" }, "Open") : h("span", { class: "muted" }, `Closed ${ago(t.closedAt)}`)));
			}))) : h("div", { class: "empty" }, "No tickets match."));
	}

	const f = {
		kind: h("select", { class: "input" }, h("option", { value: "misconduct" }, "Misconduct"), h("option", { value: "ops" }, "OPS / system")),
		title: h("input", { class: "input", placeholder: "e.g. PT Robin13031: Unprofessionalism", maxlength: "140" }),
		violations: h("input", { class: "input", placeholder: "Unprofessionalism, Reckless Driving" }),
		reporterRoblox: h("input", { class: "input", placeholder: "Accuser ROBLOX username" }),
		subject: h("select", { class: "input" }, h("option", { value: "" }, "Select from personnel…"), personnel.map(p => h("option", { value: String(p.id) }, `${p.name}${p.callsign ? ` · ${p.callsign}` : ""}`))),
		subjectNew: h("input", { class: "input", placeholder: "…or type a new name" }),
		incidentAt: h("input", { class: "input", placeholder: "In-game date / time" }),
		incidentLocation: h("input", { class: "input", placeholder: "In-game location" }),
		agent: h("select", { class: "input" }, h("option", { value: "" }, "Unassigned"), agents.map(a => h("option", { value: a.id }, a.name))),
		anonymous: h("input", { type: "checkbox" }),
		summary: h("textarea", { class: "input", rows: 5, placeholder: "Optional. Leave blank to let the drafting agent write it from the tickets." }),
		draft: h("input", { type: "checkbox", checked: true }),
		punishment: punishmentPicker(store.policy.punishments, ""),
		finding: h("select", { class: "input" }, h("option", { value: "" }, "Decide later"), store.policy.findings.map(x => h("option", { value: x.key }, x.label))),
		detail: h("input", { class: "input", placeholder: "Duration, rank, conditions" })
	};
	if (!decide) f.agent.disabled = true;

	function updateSummary() {
		const picked = tickets.filter(t => selected.has(t.ref));
		const anon = picked.some(t => t.anonymous);
		f.anonymous.checked = anon || f.anonymous.checked;
		f.anonymous.disabled = anon;
		f.draft.disabled = !picked.length;
		summaryLine.textContent = picked.length
			? `${picked.length} ticket${picked.length > 1 ? "s" : ""} selected: ${picked.map(t => t.ref).join(", ")}${anon ? " · includes an anonymous report, so the reporter is hidden from the accused" : ""}`
			: "No tickets selected. You can still open a manual case.";
		if (!f.subject.value && !f.subjectNew.value) {
			const withSubject = picked.find(t => t.subject);
			const match = withSubject && personnel.find(p => p.name === withSubject.subject);
			if (match) f.subject.value = String(match.id);
		}
		if (!f.title.value && picked[0]?.allegation) f.title.placeholder = `${picked[0].allegation}${picked[0].subject ? `: ${picked[0].subject}` : ""}`;
	}

	filter.addEventListener("input", drawTickets);
	showAttached.addEventListener("change", drawTickets);
	drawTickets();
	updateSummary();

	const submit = h("button", { class: "btn primary", onclick: create }, icon("plus"), "Open case");
	clear(page.content, h("div", { class: "stack", style: { maxWidth: "1100px" } },
		h("section", { class: "editor-section" }, h("h3", null, icon("link"), "1 · Tickets in this case"),
			h("div", { class: "row", style: { marginBottom: "10px" } }, h("div", { class: "search", style: { flex: "1 1 260px" } }, icon("search"), filter), h("label", { class: "check" }, showAttached, "Show tickets already in cases")),
			h("div", { class: "panel", style: { maxHeight: "360px", overflow: "auto" } }, ticketBox),
			h("div", { style: { marginTop: "10px" } }, summaryLine)),
		h("section", { class: "editor-section" }, h("h3", null, icon("file"), "2 · Case details"),
			h("div", { class: "stack" },
				h("div", { class: "grid-2" }, h("label", { class: "field" }, h("span", null, "Title"), f.title), h("label", { class: "field" }, h("span", null, "Type"), f.kind)),
				h("div", { class: "grid-2" }, h("label", { class: "field" }, h("span", null, "Subject (reported trooper)"), f.subject), h("label", { class: "field" }, h("span", null, "New subject"), f.subjectNew)),
				h("div", { class: "grid-3" }, h("label", { class: "field" }, h("span", null, "Incident time"), f.incidentAt), h("label", { class: "field" }, h("span", null, "Incident location"), f.incidentLocation),
					h("label", { class: "field" }, h("span", null, "Assigned agent"), f.agent, decide ? null : h("small", null, "Cases you open are assigned to you."))),
				h("div", { class: "grid-2" }, h("label", { class: "field" }, h("span", null, "Accused violations"), f.violations), h("label", { class: "field" }, h("span", null, "Accuser ROBLOX username"), f.reporterRoblox)),
				h("label", { class: "check" }, f.anonymous, "Anonymous report: the reporter's identity is never shown to the accused"),
				h("label", { class: "field" }, h("span", null, "Summary"), f.summary),
				h("label", { class: "check" }, f.draft, h("span", null, h("b", null, "Draft with AI"), " · the drafting agent writes the narrative and a recommendation from the selected tickets")))),
		decide ? h("section", { class: "editor-section" }, h("h3", null, icon("scale"), "3 · Finalised punishment (optional)"),
			h("div", { class: "grid-3" }, h("label", { class: "field" }, h("span", null, "Finding"), f.finding), h("div", { class: "field" }, h("span", null, "Punishment(s)"), f.punishment.el), h("label", { class: "field" }, h("span", null, "Detail"), f.detail)),
			h("small", { class: "muted" }, "Recorded as a draft determination. Apply your signature from the case file to approve it.")) : null,
		h("div", { class: "sticky-save" }, h("span", { class: "muted small spacer" }, "New cases start in Marked for Review. No case closes without a supervisor signature."),
			h("a", { class: "btn ghost", href: "#/board" }, "Cancel"), submit)));

	async function create() {
		submit.disabled = true;
		try {
			const res = await api("/cases", { method: "POST", body: {
				tickets: [...selected],
				kind: f.kind.value,
				title: f.title.value.trim() || (f.title.placeholder.startsWith("e.g.") ? "" : f.title.placeholder),
				subjectPersonnelId: f.subject.value || null,
				subjectName: f.subjectNew.value,
				incidentAt: f.incidentAt.value,
				incidentLocation: f.incidentLocation.value,
				assignedAgentId: f.agent.value || null,
				anonymous: f.anonymous.checked,
				summary: f.summary.value,
				draftWithAi: f.draft.checked,
				finalPunishment: f.punishment.value() || null,
				violations: f.violations.value.split(",").map(v => v.trim()).filter(Boolean),
				reporterRoblox: f.reporterRoblox.value.trim() || null,
				finalFinding: f.finding.value || null,
				finalPunishmentDetail: f.detail.value,
				finalAppealable: f.punishment.keys().some(k => store.policy.punishments.find(p => p.key === k)?.appealable)
			} });
			toast(`Case #${res.ref} opened`);
			go(`#/cases/${res.ref}`);
		} catch (error) {
			toast(error.message, "error");
			submit.disabled = false;
		}
	}
}
