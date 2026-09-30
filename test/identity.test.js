process.env.IA_DB_FILE = ":memory:";
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "none";

const test = require("node:test");
const assert = require("node:assert");
const { db, now } = require("../lib/db");
require("../lib/dossier");
const identity = require("../lib/identity");
const { classify } = require("../lib/logmatch");

const ME = "111111111111111111";
const OTHER = "222222222222222222";
const who = { discordId: ME, terms: ["xKinqAcc", "2M-008"] };
const role = message => classify({ authorId: OTHER, embeds: [], ...message }, who).role;

test("discipline and promotion logs count only when the member is the subject", () => {
	assert.equal(role({ content: "**Discipline Log**\nUsername: <@111111111111111111>\nPunishment: Strike 1\nIssued by: <@222222222222222222>" }), "subject");
	assert.equal(role({ content: "**Discipline Log**\nUsername: <@222222222222222222>\nPunishment: Strike 1\nIssued by: <@111111111111111111>", authorId: ME }), "issuer");
	assert.equal(role({ content: "Promoted: <@333333333333333333>\nPromoted To: Sergeant\nApproved By: <@111111111111111111>" }), "issuer");
	assert.equal(role({ content: "Promoted: <@111111111111111111>\nOld Rank: Trooper\nNew Rank: Sergeant\nApproved By: <@222222222222222222>" }), "subject");
	assert.equal(role({ content: "<@222222222222222222> has been demoted to Trooper. Signed <@111111111111111111>" }), "mentioned");
	assert.equal(role({ content: "<@111111111111111111> has been promoted to Corporal!" }), "subject");
	assert.equal(role({ embeds: [{ title: "Infraction", fields: [{ name: "Trooper", value: "xKinqAcc" }, { name: "Issued By", value: "Bob" }] }] }), "subject");
	assert.equal(role({ embeds: [{ title: "Infraction", fields: [{ name: "Trooper", value: "Bob" }, { name: "Issued By", value: "xKinqAcc" }] }] }), "issuer");
	assert.equal(role({ content: "Bob received a strike for RDM", authorId: ME }), "issuer");
	assert.equal(role({ content: "Nothing about them here" }), null);
});

test("SAHP nicknames give ROBLOX, callsign, and rank", () => {
	assert.deepEqual(identity.parseNickname("COMM | 2M-008 | xKinqAcc"), { roblox: "xKinqAcc", callsign: "2M-008", rank: "COMM" });
	assert.deepEqual(identity.parseNickname("TPR | 2M-114 | some_user1"), { roblox: "some_user1", callsign: "2M-114", rank: "TPR" });
	assert.deepEqual(identity.parseNickname("Just A Name"), {});
});

test("a synced member is linked to their imported record and the file shows its cases", () => {
	const t = now();
	const imported = db.prepare("INSERT INTO personnel (name, roblox_username, created_at, updated_at) VALUES ('xKinqAcc', 'xKinqAcc', ?, ?)").run(t, t).lastInsertRowid;
	db.prepare("INSERT INTO cases (ref, case_number, title, subject_personnel_id, status, created_at, updated_at) VALUES ('0500', 500, 'Old case', ?, 'closed', ?, ?)").run(imported, t, t);
	const synced = db.prepare("INSERT INTO personnel (discord_id, name, created_at, updated_at) VALUES (?, 'COMM | 2M-008 | xKinqAcc', ?, ?)").run(ME, t, t).lastInsertRowid;

	identity.fromMember(synced, "COMM | 2M-008 | xKinqAcc");
	const p = db.prepare("SELECT * FROM personnel WHERE id = ?").get(synced);
	assert.equal(p.roblox_username, "xKinqAcc");
	assert.equal(p.callsign, "2M-008");
	assert.equal(db.prepare("SELECT merged_into FROM personnel WHERE id = ?").get(imported).merged_into, synced);
	assert.equal(identity.canonicalId(imported), synced, "opening the imported record opens the main file");

	const history = require("../lib/dossier").iaHistory(p);
	assert.equal(history.cases.length, 1);
	assert.equal(history.cases[0].ref, "0500");
	assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'personnel.link'").get());
});
