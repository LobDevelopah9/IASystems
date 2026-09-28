const path = require("path");
const PDFDocument = require("pdfkit");

const SEAL = path.join(__dirname, "..", "public", "img", "ia-seal.png");
const INK = "#111111";
const MUTED = "#555555";
const RULE = "#9a7a1c";
const FOUO = "#8b1a1a";

function fmtDate(ms) {
	if (!ms) return "";
	return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}

// Renders a case (the IA serialization) as the Office of Professional Standards "Investigation Report".
function investigationReportPdf(c, { exportedBy, exportedAt = Date.now() }) {
	const doc = new PDFDocument({
		size: "LETTER",
		margins: { top: 64, bottom: 80, left: 72, right: 72 },
		bufferPages: true,
		info: { Title: `Investigation Report - Case #${c.ref}`, Author: "SAHP Office of Professional Standards", Subject: "CONFIDENTIAL / FOR OFFICIAL USE ONLY" }
	});
	const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
	const left = doc.page.margins.left;

	const rule = () => {
		doc.moveDown(0.25);
		const y = doc.y;
		doc.save().moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(RULE).stroke().restore();
		doc.moveDown(0.6);
	};
	const heading = text => {
		doc.moveDown(0.8);
		if (doc.y > doc.page.height - 180) doc.addPage();
		doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text(text);
		rule();
	};
	const sub = text => {
		doc.moveDown(0.5);
		doc.font("Helvetica-Bold").fontSize(12).fillColor(INK).text(text);
		doc.moveDown(0.3);
	};
	const field = (label, value) => {
		doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(`${label}: `, { continued: true })
			.font("Helvetica").text(value == null || value === "" ? "N/A" : String(value));
		doc.moveDown(0.15);
	};
	const paragraphs = text => {
		const parts = String(text || "").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
		if (!parts.length) {
			doc.font("Helvetica-Oblique").fontSize(11).fillColor(MUTED).text("N/A");
			return;
		}
		for (const p of parts) {
			doc.font("Helvetica").fontSize(11).fillColor(INK).text(p, { align: "justify", lineGap: 2 });
			doc.moveDown(0.6);
		}
	};

	// Letterhead
	doc.font("Helvetica").fontSize(11).fillColor(INK).text(fmtDate(c.closedAt || c.approvedAt || c.createdAt), left, doc.page.margins.top);
	const sealSize = 118;
	doc.image(SEAL, left + (width - sealSize) / 2, doc.page.margins.top + 22, { width: sealSize });
	doc.y = doc.page.margins.top + 22 + sealSize + 14;
	doc.font("Helvetica-Bold").fontSize(13).text("The Office of Professional Standards", left, doc.y, { align: "center", width });
	doc.font("Helvetica").fontSize(11);
	for (const line of ["Division of Internal Affairs", "San Andreas Highway Patrol", "Sandy Shores, BC, San Andreas", "Law Way, P.O. BOX 60597"]) {
		doc.text(line, { align: "center", width });
	}

	doc.moveDown(1.6);
	doc.font("Helvetica-Bold").fontSize(20).text("Investigation Report", { align: "left" });
	rule();
	field("Case", `#${c.ref}`);
	field("Investigator(s) Name(s)", c.investigators.join(", "));
	field("Case Classification", c.classification);
	field("Accused Violations", c.violations.join(", "));
	rule();

	const s = c.subject || {};
	doc.font("Helvetica-Bold").fontSize(12).text("Accused Trooper Contact Information");
	doc.moveDown(0.3);
	field("ROBLOX Username", s.roblox);
	field("Discord Username", s.discordUsername);
	field("Rank", s.rank);
	field("Department", s.department || "SAHP");
	rule();

	const r = c.reporter || {};
	doc.font("Helvetica-Bold").fontSize(12).text(`Accuser Contact Information${r.anonymous ? " (Anonymous: withheld from the accused)" : ""}`);
	doc.moveDown(0.3);
	field("ROBLOX Username", r.roblox);
	field("Discord Username", r.username || r.name);

	doc.addPage();
	heading("Investigation Description");
	sub("Ticket Details");
	paragraphs(c.narrative.summary);
	sub("Accused Trooper's Statement");
	paragraphs(c.narrative.interview);
	sub("Conclusion");
	paragraphs(c.report.conclusion);

	heading("Investigation Evidence");
	if (!c.report.evidence.length) {
		doc.font("Helvetica-Oblique").fontSize(11).fillColor(MUTED).text("N/A");
	}
	for (const e of c.report.evidence) {
		doc.font("Helvetica").fontSize(11);
		if (e.url) {
			doc.fillColor("#1a4fa0").text(e.label, { link: e.url, underline: true });
			doc.fillColor(MUTED).fontSize(9).text(e.url, { link: e.url });
		} else {
			doc.fillColor(INK).text(`${e.label}${e.ref ? ` (${e.ref})` : ""}`);
		}
		doc.fillColor(INK).moveDown(0.4);
	}

	heading("Investigation Conclusion");
	field("Interview Location", c.report.interviewLocation);
	field("Individuals Present During Interview", c.report.interviewPresent);
	field("Interview Comments / Notes", c.report.interviewNotes);
	doc.moveDown(0.3);
	field("Does the evidence support the allegation(s)", c.report.evidenceSupports || "PENDING");
	field("Punishment(s) Issued", c.report.punishmentsIssued || "PENDING SUPERVISOR APPROVAL");
	field("Date Investigation Was Closed", c.closedAt ? fmtDate(c.closedAt) : "OPEN");
	field("Investigation Approved & Processed By", c.report.processedBy || "PENDING");

	// Footer on every page: classification line and export stamp.
	const range = doc.bufferedPageRange();
	const stamp = `Exported by ${exportedBy.name} (${exportedBy.id}) on ${new Date(exportedAt).toISOString().replace("T", " ").slice(0, 16)} UTC · Case #${c.ref}`;
	for (let i = range.start; i < range.start + range.count; i++) {
		doc.switchToPage(i);
		const bottom = doc.page.margins.bottom;
		doc.page.margins.bottom = 0;
		const y = doc.page.height - 58;
		doc.font("Helvetica-Bold").fontSize(10).fillColor(FOUO)
			.text("CONFIDENTIAL / FOR OFFICIAL USE ONLY (FOUO)", left, y, { width, align: "center", lineBreak: false });
		doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
			.text(`${stamp} · Page ${i - range.start + 1} of ${range.count}`, left, y + 16, { width, align: "center", lineBreak: false });
		doc.page.margins.bottom = bottom;
	}
	doc.end();
	return doc;
}

module.exports = { investigationReportPdf };
