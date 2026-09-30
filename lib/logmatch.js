// Decides whether a discipline / promotion / commendation / leave log post is ABOUT a member (they received it)
// rather than merely written, signed, or approved by them. Works on plain objects so it can be tested without Discord:
//   message = { authorId, content, embeds: [{ title, description, authorName, fields: [{ name, value }], footer }] }
//   who     = { discordId, terms: [names that identify the member] }
// Returns { role: "subject" | "issuer" | "mentioned" | null, why }.

const ISSUED_TO = /\b(issued|given|handed|assigned|awarded|presented)\s+to\b/i;
const ISSUER = /\b(by|issuer|issuing|signed|signature|approved|approver|approving|authori[sz]ed|authori[sz]ing|supervisor|supervising|reviewer|reviewed|logged|logger|host|hosted|moderator|conducted|performed|handled|staff\s*member|high\s*command|promoter|demoter|reported|witness(?:es)?|requested|submitted|from\s*hr)\b/i;
const SUBJECT = /\b(user(?:name)?|member|subject|trooper|officer|deputy|employee|recipient|name|discord|roblox|promoted|demoted|promotee|demotee|punished|disciplined|target|individual|personnel|person|who|offender|accused|infractee|player|agent|cadet|probationary|probie|suspect|awardee|honoree|nominee)\b/i;
// Single, non-nested quantifiers only: a nested one here once hung the server on "-----" separator lines.
const KV = /^[\s>*_~`•·-]{0,12}([A-Za-z][A-Za-z0-9 /'()&.#]{0,40}?)[*_~`\s]{0,6}(?::|：|»|→|->| - | – | — )\s*(.+)$/;
const MENTION = /<@!?(\d{15,22})>/g;

function escapeRe(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keyRole(key) {
	const k = String(key || "").replace(/[*_~`]/g, "").trim();
	if (!k || /^https?$/i.test(k)) return null;
	if (ISSUED_TO.test(k)) return "subject";
	// "Promoted To", "Old Rank", "Date": details of the action, not a person.
	if (/\b(to|from|rank|position|new|old|previous|current|date|time|reason|length|duration|type)\b/i.test(k) && !ISSUER.test(k.replace(/\bfrom\b/i, ""))) return null;
	if (ISSUER.test(k)) return "issuer";
	if (SUBJECT.test(k)) return "subject";
	return null;
}

function pairsOf(message) {
	const pairs = [];
	const loose = [];
	const addText = (text, source) => {
		for (const line of String(text || "").split(/\r?\n/)) {
			if (!line.trim()) continue;
			const kv = line.length <= 600 ? line.match(KV) : null;
			const role = kv ? keyRole(kv[1]) : null;
			if (kv && role) pairs.push({ key: kv[1], value: kv[2], role, source });
			else loose.push({ text: line, source });
		}
	};
	addText(message.content, "content");
	for (const e of message.embeds || []) {
		if (e.title) loose.push({ text: e.title, source: "embed-title" });
		addText(e.description, "embed");
		for (const f of e.fields || []) {
			const role = keyRole(f.name);
			if (role) pairs.push({ key: f.name, value: String(f.value || ""), role, source: "field" });
			else addText(`${f.name}: ${f.value}`, "field");
		}
		if (e.footer) loose.push({ text: e.footer, source: "footer" });
	}
	return { pairs, loose };
}

function matcherFor({ discordId, terms = [] }) {
	const clean = [...new Set(terms.map(t => String(t || "").trim()).filter(t => t.length >= 3))];
	const parts = [discordId ? `<@!?${discordId}>` : null, ...clean.map(t => `(?<![A-Za-z0-9_])${escapeRe(t)}(?![A-Za-z0-9_])`)].filter(Boolean);
	return parts.length ? new RegExp(parts.join("|"), "i") : null;
}

function classify(message, who) {
	const re = matcherFor(who);
	if (!re) return { role: null, why: "no identifiers" };
	const { pairs, loose } = pairsOf(message);
	const hit = text => re.test(String(text || ""));
	const isAuthor = who.discordId && message.authorId === who.discordId;

	// 1. Structured logs ("Username: @x", "Issued by: @y", embed fields) are decided by the labelled field.
	const subjectPairs = pairs.filter(p => p.role === "subject");
	if (subjectPairs.some(p => hit(p.value))) return { role: "subject", why: `named under "${subjectPairs.find(p => hit(p.value)).key.trim()}"` };
	if (pairs.some(p => p.role === "issuer" && hit(p.value))) return { role: "issuer", why: "named as the issuer / approver" };
	if (subjectPairs.length) return hit([message.content, ...(message.embeds || []).map(e => JSON.stringify(e))].join("\n")) ? { role: "mentioned", why: "mentioned, but another member is the subject" } : { role: null };

	// 2. Embed author line (log bots often put the disciplined member there).
	const embedAuthor = (message.embeds || []).find(e => e.authorName && hit(e.authorName));
	if (embedAuthor && !isAuthor) return { role: "subject", why: "embed author" };

	// 3. Unstructured text: the first member pinged (outside signature lines) is the subject.
	const body = loose.filter(l => l.source !== "footer").map(l => l.text);
	const issuerLines = pairs.filter(p => p.role === "issuer").map(p => p.value).join("\n");
	const firstMention = [...body.join("\n").matchAll(MENTION)].map(m => m[1]).find(id => !issuerLines.includes(id));
	if (firstMention) {
		if (who.discordId && firstMention === who.discordId) return isAuthor ? { role: "issuer", why: "posted by the member about themselves" } : { role: "subject", why: "first member pinged" };
		return hit(body.join("\n")) ? { role: "mentioned", why: "another member is pinged first" } : { role: null };
	}
	if (isAuthor) return { role: "issuer", why: "posted by the member" };

	// 4. No pings at all: a name in the body counts, a name only in a trailing signature line does not.
	const lines = body.filter(t => t.trim());
	const idx = lines.findIndex(hit);
	if (idx === -1) return hit(loose.filter(l => l.source === "footer").map(l => l.text).join("\n")) ? { role: "issuer", why: "named in the footer" } : { role: null };
	const signature = lines.length >= 3 && idx === lines.length - 1 && /^\s*[-–—~]|\b(signed|regards|approved)\b/i.test(lines[idx]);
	return signature ? { role: "issuer", why: "named in the signature line" } : { role: "subject", why: "named in the log text" };
}

module.exports = { classify, keyRole, pairsOf, matcherFor };
