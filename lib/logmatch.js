// Decides whether a discipline / promotion / commendation / leave log post is ABOUT a member (they received it)
// rather than merely written, signed, or approved by them. Works on plain objects so it can be tested without Discord:
//   message = { authorId, content, embeds: [{ title, description, authorName, fields: [{ name, value }], footer }] }
//   who     = { discordId, terms: [names that identify the member] }
// Returns { role, why } (see classify).

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

// Roles: "subject" (clearly received it), "unclear" (named, but the post does not say how; the AI decides),
// "issuer" (wrote, issued, approved, or ran the command), "other" (someone else is the subject), null (not named).
// Words around a name that mark the issuer / the recipient. No nested quantifiers (see the note on KV above).
const ISSUER_BEFORE = /(?:\bby|\bfrom|\bsigned|\bapproved|\bauthori[sz]ed|\bissuer|\bstaff|\bmoderator|\bofficer in charge|\bsupervisor|\bhost(?:ed)?|\bcc|[-–—~]|\/s)[\s:*_>|,.-]{0,6}$/i;
const SUBJECT_BEFORE = /(?:\bto|\bpromoted|\bdemoted|\bpromoting|\bdemoting|\bpromote|\bdemote|\bwarned|\bwarning|\bpunished|\bsuspended|\bsuspending|\bterminated|\bterminating|\bfired|\bstrike|\bstriked|\binfraction|\bagainst|\bfor|\bcongratulations|\bcongrats|\bwelcome|\bdisciplin\w*|\bblacklisted|\bremoved)[\s:*_>|,.!-]{0,6}$/i;
const ISSUER_AFTER = /^[\s*_,]{0,4}(?:has\s+|have\s+|had\s+)?(?:issued|gave|given|promoted|demoted|punished|warned|struck|suspended|terminated|awarded|approved|logged|signed|removed|blacklisted|infracted|striked)\b(?!\s+(?:by|to\b))/i;
const SUBJECT_AFTER = /^[\s*_,]{0,4}(?:has\s+been|have\s+been|was|is|got|gets|received|receives|recieved|is\s+now|has\s+received|you\s+have\s+been)\b/i;

// How the member is named at each place they appear: { index, text } in a line.
function contextRole(line, re) {
	const global = new RegExp(re.source, "gi");
	let verdict = null;
	for (const m of line.matchAll(global)) {
		const before = line.slice(Math.max(0, m.index - 60), m.index);
		const after = line.slice(m.index + m[0].length, m.index + m[0].length + 60);
		if (ISSUER_BEFORE.test(before) || ISSUER_AFTER.test(after)) return "issuer";
		if (SUBJECT_BEFORE.test(before) || SUBJECT_AFTER.test(after)) verdict = "subject";
	}
	return verdict;
}

function classify(message, who) {
	const re = matcherFor(who);
	if (!re) return { role: null, why: "no identifiers" };
	const hit = text => re.test(String(text || ""));

	// 0. A member who wrote the post issued or logged it. Their own discipline is logged by someone else.
	if (who.discordId && message.authorId === who.discordId) return { role: "issuer", why: "posted by the member" };

	const { pairs, loose } = pairsOf(message);

	// 1. Labelled fields decide ("Username: @x", "Issued by: @y", embed fields).
	const subjectPairs = pairs.filter(p => p.role === "subject");
	const issuerHit = pairs.find(p => p.role === "issuer" && hit(p.value));
	const subjectHit = subjectPairs.find(p => hit(p.value));
	if (subjectHit && !issuerHit) return { role: "subject", why: `named under "${subjectHit.key.trim()}"` };
	if (issuerHit && !subjectHit) return { role: "issuer", why: `named under "${issuerHit.key.trim()}"` };
	if (subjectHit && issuerHit) return { role: "unclear", why: "named as both subject and issuer" };
	const all = [message.content, ...(message.embeds || []).flatMap(e => [e.title, e.description, e.authorName, e.footer, ...(e.fields || []).flatMap(f => [f.name, f.value])])].join("\n");
	if (subjectPairs.length) return hit(all) ? { role: "other", why: "another member is the labelled subject" } : { role: null };

	// 2. Embed author and footer are the staff member who ran the log command.
	const embeds = message.embeds || [];
	const inBody = hit([message.content, ...embeds.flatMap(e => [e.title, e.description, ...(e.fields || []).flatMap(f => [f.name, f.value])])].join("\n"));
	if (!inBody) return hit(all) ? { role: "issuer", why: "named only as the embed author or footer" } : { role: null };

	// 3. Wording around the name: "issued by @x" / "@x promoted ..." vs "promoted @x" / "@x has been ...".
	const lines = loose.filter(l => l.source !== "footer").map(l => l.text);
	const roles = lines.map(line => (hit(line) ? contextRole(line, re) : null)).filter(Boolean);
	if (roles.includes("issuer") && !roles.includes("subject")) return { role: "issuer", why: "named as the one taking the action" };
	if (roles.includes("subject") && !roles.includes("issuer")) return { role: "subject", why: "named as the one receiving the action" };

	// 4. The first member pinged, when no wording says otherwise, is usually the subject; anything else is unclear.
	const body = lines.join("\n");
	const firstMention = [...body.matchAll(MENTION)].map(m => m[1])[0];
	if (firstMention && who.discordId && firstMention !== who.discordId) return { role: "other", why: "another member is pinged first" };
	if (firstMention && firstMention === who.discordId && !roles.length) return { role: "unclear", why: "pinged first" };
	return { role: "unclear", why: "named in the post" };
}

module.exports = { classify, keyRole, pairsOf, matcherFor };
