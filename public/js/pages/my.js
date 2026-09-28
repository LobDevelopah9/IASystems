import { h, clear, icon, api, fmtDate, attempt, modal, closeLayer, statusPill, watermark } from "../lib.js";
import { store } from "../state.js";

export async function render({ page, isCurrent }) {
	page.setTitle("My IA Record", "Outcomes of Internal Affairs cases where you are the subject.");
	const { cases } = await api("/my/cases");
	if (!isCurrent()) return;
	clear(page.content, h("div", { class: "stack member-card" },
		h("div", { class: "panel" }, h("div", { class: "panel-body row" }, icon("shield"),
			h("div", { class: "spacer" }, h("b", null, "Your record is confidential. "), h("span", { class: "muted" }, "You see the determination and the notice addressed to you. Investigation material, witness identities, and internal deliberations are not shown. Cases appear here once a supervisor has approved them.")))),
		cases.length ? cases.map(caseCard) : h("div", { class: "panel" }, h("div", { class: "empty" }, icon("check"), h("div", null, "You have no approved Internal Affairs determinations on record.")))));

	function caseCard(c) {
		return h("article", { class: "casefile", dataset: { contained: "" } },
			h("header", { class: "casefile-head" },
				h("div", { class: "strip" }, h("img", { src: "img/ia-seal.png", alt: "" }), "Office of Professional Standards · Notice of Determination"),
				h("h2", null, c.title),
				h("div", { class: "row" }, h("span", { class: "ref-big" }, `Case #${c.ref}`), statusPill(c.status)),
				c.violations?.length ? h("div", { class: "muted small", style: { marginTop: "6px" } }, `Violations: ${c.violations.join(", ")}`) : null),
			h("div", { class: "section" },
				h("div", { class: "outcome" },
					h("div", null, h("label", null, "Finding"), h("b", null, store.policy.findings.find(f => f.key === c.finding)?.label || "-")),
					h("div", null, h("label", null, "Outcome"), h("b", null, c.punishment || "-"), c.punishmentDetail ? h("div", { class: "muted small" }, c.punishmentDetail) : null),
					h("div", null, h("label", null, "Appealable"), h("b", null, c.appealable ? "Yes" : "No"))),
				c.notice ? h("div", { class: "prose" }, c.notice) : null,
				c.signedBy ? h("div", { class: "sigblock" }, h("div", { class: "sig" }, c.signedBy.name), h("div", null, [c.signedBy.title, fmtDate(c.signedBy.at)].filter(Boolean).join(" · "))) : null,
				h("div", { class: "row", style: { marginTop: "14px" } },
					c.appeal ? h("span", { class: "tag violet" }, icon("flag"), `Appeal ${c.appeal.status} · ${fmtDate(c.appeal.created_at, false)}`) : null,
					c.canAppeal ? h("button", { class: "btn", onclick: () => appeal(c) }, icon("flag"), "Request an appeal") : null)),
			watermark());
	}

	function appeal(c) {
		const reason = h("textarea", { class: "input", rows: 6, placeholder: "Explain why the determination should be reconsidered. Include any new evidence." });
		modal({
			title: `Appeal case #${c.ref}`,
			body: h("div", { class: "stack" }, h("p", { class: "muted" }, "Your appeal goes to IA supervisors. You can submit one appeal per case."), reason),
			actions: [
				h("button", { class: "btn ghost", onclick: closeLayer }, "Cancel"),
				h("button", { class: "btn primary", onclick: async () => {
					await attempt(() => api(`/my/cases/${encodeURIComponent(c.ref)}/appeal`, { method: "POST", body: { reason: reason.value } }), "Appeal submitted");
					closeLayer();
					render({ page, isCurrent });
				} }, "Submit appeal")
			]
		});
	}
}
