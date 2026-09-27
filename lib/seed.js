const crypto = require("crypto");
const { db, now, getSetting, setSetting } = require("./db");
const tickets = require("./tickets");
const cases = require("./cases");

const HOUR = 3600000;
const DAY = 24 * HOUR;

const USERS = [
	{ id: "900000000000000001", name: "Cmdr. Elena Voss", username: "evoss", role: "director", callsign: "IA-1", badge: "1001", title: "Commander, Head of Internal Affairs", roblox: "EVoss_IA" },
	{ id: "900000000000000002", name: "Lt. Daniel Brooks", username: "dbrooks", role: "supervisor", callsign: "IA-2", badge: "1044", title: "Lieutenant, OPS Supervisor", roblox: "DBrooksRBX" },
	{ id: "900000000000000003", name: "Det. Priya Nair", username: "pnair", role: "investigator", callsign: "IA-11", badge: "2107", title: "Detective, IA Investigator", roblox: "PNair_SAHP" },
	{ id: "900000000000000004", name: "Det. Owen Mercer", username: "omercer", role: "investigator", callsign: "IA-12", badge: "2131", title: "Detective, IA Investigator", roblox: "OwenMercer22" },
	{ id: "900000000000000005", name: "Tpr. Jordan Hale", username: "jhale", role: "trooper", callsign: "SAHP-214", roblox: "JHale_SAHP", du: "jhale" },
	{ id: "900000000000000006", name: "Tpr. Alyssa Cortez", username: "acortez", role: "trooper", callsign: "SAHP-231", roblox: "AlyCortez", du: "acortez" }
];

const PERSONNEL = [
	{ key: "hale", discord: "900000000000000005", name: "Tpr. Jordan Hale", callsign: "SAHP-214", rank: "TPR", roblox: "JHale_SAHP", du: "jhale" },
	{ key: "cortez", discord: "900000000000000006", name: "Tpr. Alyssa Cortez", callsign: "SAHP-231", rank: "TPR", roblox: "AlyCortez", du: "acortez" },
	{ key: "reyes", name: "Sgt. Marcus Reyes", callsign: "SAHP-120", rank: "SGT", roblox: "MReyesRBX", du: "mreyes" },
	{ key: "park", name: "PT Devin Park", callsign: "SAHP-248", rank: "PT", roblox: "DevParkk", du: "devpark" },
	{ key: "whitaker", name: "Cpl. Sam Whitaker", callsign: "SAHP-162", rank: "CPL", roblox: "SWhitaker01", du: "swhit" }
];

function seedUsers() {
	for (const u of USERS) {
		db.prepare(`INSERT OR IGNORE INTO users (discord_id, username, display_name, mapped_role, role_override, in_guild, callsign, badge_number, title, roblox_username, created_at, updated_at, demo)
			VALUES (?, ?, ?, 'none', ?, 1, ?, ?, ?, ?, ?, ?, 1)`)
			.run(u.id, u.username, u.name, u.role, u.callsign || null, u.badge || null, u.title || null, u.roblox || null, now() - 40 * DAY, now());
	}
	const map = {};
	for (const p of PERSONNEL) {
		const info = db.prepare("INSERT INTO personnel (discord_id, name, callsign, roblox_username, discord_username, rank, created_at, updated_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)")
			.run(p.discord || null, p.name, p.callsign, p.roblox, p.du, p.rank, now() - 40 * DAY, now());
		map[p.key] = info.lastInsertRowid;
	}
	return map;
}

function makeTicket({ type, opener, anonymous = false, subject, intake, daysAgo, lines, closed = true }) {
	const openedAt = now() - daysAgo * DAY;
	const t = tickets.openTicket({
		type, openerId: opener.id, openerName: opener.name, anonymous, subjectPersonnelId: subject || null,
		subjectText: intake.subjectGiven || null, intake, openedAt, demo: true
	});
	const messages = lines.map(([who, content], i) => ({
		authorId: who.id, authorName: who.name, isBot: Boolean(who.bot), content, createdAt: openedAt + (i + 1) * 4 * 60000
	}));
	tickets.storeTranscript(t.id, messages);
	if (closed) db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?").run(openedAt + DAY / 2, USERS[2].id, t.id);
	return db.prepare("SELECT * FROM tickets WHERE id = ?").get(t.id);
}

function makeCase({ tickets: ts, kind = "misconduct", title, subject, reporter, anonymous, status, daysAgo, agent, incidentAt, location, narrative, ai, sign, notes, violations = [], conclusion = "", interviewNotes = "N/A" }) {
	const row = cases.createCase({
		kind, title, subjectPersonnelId: subject, reporterId: reporter?.id || null, reporterName: reporter?.name || null,
		reporterUsername: reporter?.du || null, reporterRoblox: reporter?.roblox || null, violations,
		anonymous, incidentAt, incidentLocation: location, assignedAgentId: agent || null, ticketIds: ts.map(t => t.id), demo: true,
		evidence: tickets.extractEvidence(ts), interviewPresent: tickets.participants(ts).join(", ")
	}, null, "bot");
	db.prepare("UPDATE cases SET conclusion = ?, interview_notes = ? WHERE id = ?").run(conclusion, interviewNotes, row.id);
	const created = now() - daysAgo * DAY;
	const r = ref => ts.find(t => t.type === ref.type)?.ref + `#${ref.n}`;
	const map = list => (list || []).map(r);
	db.prepare(`UPDATE cases SET created_at = ?, updated_at = ?, narrative_summary = ?, narrative_timeline = ?, narrative_excerpts = ?,
		narrative_interview = ?, narrative_location = ?, narrative_sources = ?, ai_state = 'ready' WHERE id = ?`).run(
		created, created + HOUR,
		narrative.summary,
		JSON.stringify(narrative.timeline.map(item => ({ when: item.when, event: item.event, sources: map(item.src) }))),
		JSON.stringify(narrative.excerpts.map(e => ({ ref: r(e.src), speaker: e.speaker, quote: e.quote, relevance: e.relevance }))),
		narrative.interview || "",
		narrative.location || "",
		JSON.stringify({ summary: map(narrative.summarySrc), interview: map(narrative.interviewSrc), location: map(narrative.locationSrc) }),
		row.id
	);
	const hash = crypto.createHash("sha256").update(`${row.ref}:${JSON.stringify(ai)}`).digest("hex");
	db.prepare(`INSERT INTO ai_decisions (case_id, finding, punishment, punishment_detail, appealable, rationale, signature, model, content_hash, signed_at, demo)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(row.id, ai.finding, ai.punishment, ai.detail || "", ai.appealable ? 1 : 0, ai.rationale,
		"IA Drafting Agent · demo/seed · recommendation only, not a finding", "demo-seed", hash, created + HOUR);

	if (sign) {
		const signer = USERS.find(u => u.id === sign.by);
		db.prepare(`UPDATE cases SET final_finding = ?, final_punishment = ?, final_punishment_detail = ?, final_appealable = ?, subject_notice = ?, approved_at = ? WHERE id = ?`)
			.run(sign.finding, sign.punishment, sign.detail || "", sign.appealable ? 1 : 0, sign.notice || "", created + 2 * DAY, row.id);
		const current = db.prepare("SELECT * FROM cases WHERE id = ?").get(row.id);
		db.prepare(`INSERT INTO signatures (case_id, signer_id, signer_name, signer_title, finding, punishment, punishment_detail, appealable, statement, content_hash, signed_at, demo)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(row.id, signer.id, signer.name, signer.title, sign.finding, sign.punishment, sign.detail || "",
			sign.appealable ? 1 : 0, sign.statement || "", cases.contentHash(current), created + 2 * DAY);
	}
	db.prepare("UPDATE cases SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN ? ELSE NULL END WHERE id = ?").run(status, status, created + 3 * DAY, row.id);
	for (const note of notes || []) {
		const author = USERS.find(u => u.id === note.by);
		db.prepare("INSERT INTO case_notes (case_id, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)").run(row.id, author.id, author.name, note.body, created + note.h * HOUR);
	}
	cases.indexCase(row.id);
	return db.prepare("SELECT * FROM cases WHERE id = ?").get(row.id);
}

function seedDemo() {
	if (getSetting("demo_seeded", false)) return;
	if (db.prepare("SELECT 1 FROM cases LIMIT 1").get()) return;

	db.transaction(() => {
		const p = seedUsers();
		const [voss, brooks, nair, mercer, hale, cortez] = USERS;
		const bot = { id: "900000000000000099", name: "SAHP IA Bot", bot: true };
		const anonReporter = { id: "900000000000000050", name: "Tpr. Casey Lindqvist", roblox: "CaseyLindq", du: "lindq" };

		// Case 1: anonymous report + separate interview ticket (the canonical linked case).
		const t1 = makeTicket({
			type: "report", opener: anonReporter, anonymous: true, subject: p.hale, daysAgo: 3,
			intake: { subjectGiven: "Tpr. Jordan Hale", allegation: "Unauthorised PIT at high speed", when: "12 Sep, ~21:40 server time", location: "Great Ocean Hwy, north of Chumash pier", details: "Hale PIT'd a sedan at 110+ mph with civilians nearby." },
			lines: [
				[bot, "Anonymous report received. Subject: Tpr. Jordan Hale. Allegation: Unauthorised PIT at high speed."],
				[anonReporter, "I was secondary unit on the pursuit. Hale called 'PIT PIT PIT' and hit the sedan doing about 115 on the Great Ocean Highway, right by the Chumash pier turnoff."],
				[nair, "Thanks. Was a PIT authorised by a supervisor on the radio before contact?"],
				[anonReporter, "No. Sgt. Reyes had said 'no PITs above 60, back off if it gets dangerous' about a minute earlier. There were two civilian cars in the right lane."],
				[anonReporter, "Here's my clip: https://medal.tv/games/roblox/clips/demoPITclip01 Please keep my name away from Hale, I ride with him a lot."],
				[nair, "Understood. Your identity stays with IA leadership only. Anything else?"],
				[anonReporter, "The sedan rolled into the barrier. Nobody was hurt but it was close."]
			]
		});
		const t2 = makeTicket({
			type: "interview", opener: nair, subject: p.hale, daysAgo: 2,
			intake: { reason: "Pursuit on 12 Sep, Great Ocean Hwy" },
			lines: [
				[bot, "Internal Affairs interview opened. Interviewing investigator: Det. Priya Nair."],
				[nair, "Tpr. Hale, this is about the pursuit on 12 September on the Great Ocean Highway. Did you perform a PIT manoeuvre?"],
				[hale, "Yes. The suspect was swerving at civilians and I judged it was the safest way to end it."],
				[nair, "Did you hear Sgt. Reyes restrict PITs above 60 mph?"],
				[hale, "I heard something from Reyes but the radio was busy. I didn't catch the speed limit part."],
				[nair, "What speed were you travelling at the moment of contact?"],
				[hale, "Probably around 100, maybe a bit more. I know that's high."],
				[nair, "Thank you. That concludes the interview."]
			]
		});
		makeCase({
			tickets: [t1, t2], title: "Unauthorised high-speed PIT: Tpr. Jordan Hale", subject: p.hale, reporter: anonReporter, anonymous: true,
			status: "marked_for_review", daysAgo: 2, agent: nair.id, incidentAt: "12 Sep, ~21:40 server time", location: "Great Ocean Hwy near Chumash pier",
			narrative: {
				summary: "On Sep 24, 2026, an anonymous trooper report ticket was opened by Trooper CaseyLindq, reporting Trooper JHale_SAHP for an unauthorised PIT manoeuvre at high speed. I claimed the ticket and asked the reporting party whether a PIT had been authorised by a supervisor before contact.\n\nThe reporting party stated that they were the secondary unit in the pursuit and that Sergeant MReyesRBX had said \"no PITs above 60, back off if it gets dangerous\" about a minute before Trooper JHale_SAHP called a PIT and made contact with the suspect sedan at approximately 115 MPH on the Great Ocean Highway near the Chumash pier turnoff. Two civilian vehicles were in the right lane at the time. The suspect vehicle rolled into the barrier; nobody was hurt. The reporting party provided a clip of the incident and asked that their identity be kept from the accused.\n\nOn Sep 25, 2026, I opened a separate interview ticket with Trooper JHale_SAHP regarding the pursuit.",
				summarySrc: [{ type: "report", n: 2 }, { type: "report", n: 4 }, { type: "interview", n: 3 }, { type: "interview", n: 7 }],
				timeline: [
					{ when: "12 Sep ~21:39", event: "Sgt. Reyes restricts PIT manoeuvres above 60 mph on the radio.", src: [{ type: "report", n: 4 }] },
					{ when: "12 Sep ~21:40", event: "Tpr. Hale calls a PIT and makes contact with the suspect sedan at roughly 110-115 mph near the Chumash pier turnoff.", src: [{ type: "report", n: 2 }] },
					{ when: "12 Sep ~21:40", event: "Suspect vehicle strikes the barrier. No injuries reported.", src: [{ type: "report", n: 7 }] },
					{ when: "14 Sep", event: "Interview conducted by Det. Nair; Tpr. Hale admits the PIT at approximately 100+ mph.", src: [{ type: "interview", n: 7 }] }
				],
				excerpts: [
					{ src: { type: "report", n: 4 }, speaker: "Anonymous Reporter", quote: "Sgt. Reyes had said 'no PITs above 60, back off if it gets dangerous' about a minute earlier.", relevance: "Establishes a supervisory restriction was in place." },
					{ src: { type: "interview", n: 5 }, speaker: "Tpr. Jordan Hale", quote: "I heard something from Reyes but the radio was busy. I didn't catch the speed limit part.", relevance: "Subject's explanation for disregarding the restriction." },
					{ src: { type: "interview", n: 7 }, speaker: "Tpr. Jordan Hale", quote: "Probably around 100, maybe a bit more. I know that's high.", relevance: "Admission of speed at contact." }
				],
				interview: "I requested Trooper JHale_SAHP's statement in the interview ticket, and he responded by stating the following; that he performed the PIT because the suspect was swerving at civilians and he judged it the safest way to end the pursuit. He stated that he heard a transmission from Sergeant MReyesRBX but the radio was busy and he did not catch the speed restriction. When asked his speed at the moment of contact, he stated \"Probably around 100, maybe a bit more. I know that's high.\"",
				interviewSrc: [{ type: "interview", n: 3 }, { type: "interview", n: 5 }, { type: "interview", n: 7 }],
				location: "Great Ocean Highway, northbound, near the Chumash pier turnoff. Two civilian vehicles were in the right lane at the time of contact.",
				locationSrc: [{ type: "report", n: 2 }, { type: "report", n: 4 }]
			},
			violations: ["Reckless Driving", "Failure to Follow Supervisor Instructions", "Pursuit Policy Violation"],
			conclusion: "After collecting both the accuser and accused statements, it is clear to me that Trooper JHale_SAHP performed a PIT manoeuvre at over 100 MPH after a supervisor had restricted PITs above 60 MPH, with civilian vehicles in the adjacent lane. His explanation that the radio was busy is partially mitigating, and no one was injured, but the manoeuvre placed civilians at unnecessary risk. The trooper will be issued X1 Black Mark and returned to FTO for pursuit-policy retraining.",
			interviewNotes: "Trooper was cooperative and answered all questions.",
			ai: { finding: "sustained", punishment: "black_mark,fto", detail: "X1 Black Mark", appealable: true, rationale: "The subject admits performing a PIT at approximately 100+ mph after a supervisory restriction of 60 mph was issued, with civilians nearby. The subject's claim that the radio was busy is partially mitigating, and no injuries occurred. A written warning with retraining is proportionate for a first pursuit-policy violation. (Confidence: high.)" },
			notes: [{ by: nair.id, body: "Clip received from the reporter and reviewed. Speed on the HUD reads 112 mph at contact.", h: 20 }]
		});

		// Case 2: under investigation, named reporter.
		const t3 = makeTicket({
			type: "report", opener: cortez, subject: p.reyes, daysAgo: 6,
			intake: { subjectGiven: "Sgt. Marcus Reyes", allegation: "Belittling troopers on radio", when: "Multiple shifts, 1-8 Sep", location: "Radio channel SAHP-1", details: "Repeated demeaning comments to probationary troopers on the main channel." },
			lines: [
				[bot, "Report received. Subject: Sgt. Marcus Reyes."],
				[cortez, "Over the last week Sgt. Reyes has repeatedly mocked probationary troopers on SAHP-1. On 3 Sep he said 'if you can't run a plate, go back to the academy, you're wasting my air time'."],
				[mercer, "Were other supervisors on the channel during these comments?"],
				[cortez, "Cpl. Whitaker was on for at least two of them. He didn't say anything."],
				[cortez, "It's making the new people afraid to use the radio at all."]
			]
		});
		makeCase({
			tickets: [t3], title: "Conduct unbecoming on radio: Sgt. Marcus Reyes", subject: p.reyes, reporter: cortez, anonymous: false,
			status: "under_investigation", daysAgo: 5, agent: mercer.id, incidentAt: "1-8 Sep, multiple shifts", location: "Radio channel SAHP-1",
			narrative: {
				summary: "Tpr. Alyssa Cortez reports that Sgt. Marcus Reyes repeatedly made demeaning remarks to probationary troopers on the main radio channel over roughly one week, including a quoted remark on 3 September. Cpl. Sam Whitaker was reportedly present on the channel for at least two incidents.",
				summarySrc: [{ type: "report", n: 2 }, { type: "report", n: 4 }],
				timeline: [
					{ when: "3 Sep", event: "Sgt. Reyes allegedly tells a probationary trooper to 'go back to the academy' on SAHP-1.", src: [{ type: "report", n: 2 }] },
					{ when: "1-8 Sep", event: "Further demeaning remarks reported across multiple shifts.", src: [{ type: "report", n: 2 }, { type: "report", n: 5 }] }
				],
				excerpts: [{ src: { type: "report", n: 2 }, speaker: "Tpr. Alyssa Cortez", quote: "if you can't run a plate, go back to the academy, you're wasting my air time", relevance: "Quoted remark attributed to the subject." }],
				location: "Main radio channel SAHP-1.", locationSrc: [{ type: "report", n: 2 }]
			},
			violations: ["Unprofessionalism", "Conduct Unbecoming"],
			ai: { finding: "not_sustained", punishment: "verbal_warning", appealable: false, rationale: "A single witness account describes a pattern of demeaning radio conduct. Without corroborating recordings or witness statements the allegation cannot yet be sustained. Recommend interviewing Cpl. Whitaker and obtaining radio logs before a final finding. (Confidence: low.)" },
			notes: [
				{ by: brooks.id, body: "Sent back for investigation. Owen, please interview Whitaker and pull radio logs for 1-8 Sep.", h: 30 },
				{ by: mercer.id, body: "Interview with Whitaker scheduled for Thursday.", h: 50 }
			]
		});

		// Case 3: approved and signed.
		const t4 = makeTicket({
			type: "report", opener: hale, subject: p.park, daysAgo: 12,
			intake: { subjectGiven: "Tpr. Devin Park", allegation: "Using patrol vehicle off duty", when: "30 Aug, 23:00", location: "Vinewood Hills", details: "Park took an SAHP interceptor to a car meet while off duty." },
			lines: [
				[bot, "Report received. Subject: Tpr. Devin Park."],
				[hale, "Park showed up to the Vinewood Hills car meet in an SAHP interceptor with lights on, off duty, around 23:00 on 30 Aug."],
				[nair, "Did he state whether he was on shift?"],
				[hale, "He said in chat he'd clocked out an hour earlier and 'just borrowed' the car."]
			]
		});
		makeCase({
			tickets: [t4], title: "Misuse of patrol vehicle off duty: Tpr. Devin Park", subject: p.park, reporter: hale, anonymous: false,
			status: "approved", daysAgo: 10, agent: nair.id, incidentAt: "30 Aug, 23:00", location: "Vinewood Hills car meet",
			narrative: {
				summary: "Tpr. Jordan Hale reports that Tpr. Devin Park attended a car meet in Vinewood Hills in an SAHP interceptor with emergency lights active while off duty, and stated he had clocked out and 'just borrowed' the vehicle.",
				summarySrc: [{ type: "report", n: 2 }, { type: "report", n: 4 }],
				timeline: [{ when: "30 Aug ~23:00", event: "Tpr. Park arrives at the Vinewood Hills car meet in an SAHP interceptor, off duty.", src: [{ type: "report", n: 2 }] }],
				excerpts: [{ src: { type: "report", n: 4 }, speaker: "Tpr. Jordan Hale", quote: "He said in chat he'd clocked out an hour earlier and 'just borrowed' the car.", relevance: "Indicates knowing off-duty use." }],
				location: "Vinewood Hills, public car meet.", locationSrc: [{ type: "report", n: 2 }]
			},
			violations: ["Misuse of Department Vehicle", "General Misconduct"],
			conclusion: "After collecting the reporting party's statement and reviewing the accused's own admission in chat, it is clear to me that Probationary Trooper DevParkk knowingly used an SAHP interceptor with emergency lighting while off duty. He will be issued X1 Black Mark and a 7-day suspension of interceptor access.",
			ai: { finding: "sustained", punishment: "black_mark", detail: "X1 Black Mark", appealable: true, rationale: "Report and the subject's own chat statement indicate knowing off-duty use of department property with emergency lighting. A strike is proportionate. (Confidence: medium.)" },
			sign: { by: brooks.id, finding: "sustained", punishment: "black_mark,suspension", detail: "X1 Black Mark; 7-day interceptor suspension", appealable: true, statement: "Sustained on the report and the subject's own admission in chat.", notice: "You are issued one strike for using an SAHP interceptor while off duty. Interceptor access is suspended for 7 days. You may appeal this decision within 7 days." }
		});

		// Case 4: closed, visible to Tpr. Hale in the member view.
		const t5 = makeTicket({
			type: "ops", opener: brooks, subject: p.hale, daysAgo: 30,
			intake: { summary: "Use-of-force report not filed", system: "Use-of-force reporting", when: "18 Aug", details: "Tpr. Hale did not file a UOF report after a taser deployment." },
			lines: [
				[bot, "OPS report received."],
				[brooks, "Audit of 18 Aug shows Tpr. Hale deployed a taser during an arrest at Paleto Bay but no use-of-force report was filed."],
				[hale, "I forgot to file it after the server restart. I've filed it now."]
			]
		});
		makeCase({
			tickets: [t5], title: "Late use-of-force report: Tpr. Jordan Hale", subject: p.hale, reporter: brooks, anonymous: false,
			status: "closed", daysAgo: 28, agent: mercer.id, incidentAt: "18 Aug", location: "Paleto Bay",
			narrative: {
				summary: "An OPS audit found that Tpr. Jordan Hale did not file a use-of-force report after a taser deployment at Paleto Bay on 18 August. The trooper acknowledged the omission and filed the report late.",
				summarySrc: [{ type: "ops", n: 2 }, { type: "ops", n: 3 }],
				timeline: [
					{ when: "18 Aug", event: "Taser deployed during an arrest at Paleto Bay; no UOF report filed.", src: [{ type: "ops", n: 2 }] },
					{ when: "Later", event: "Tpr. Hale files the report late.", src: [{ type: "ops", n: 3 }] }
				],
				excerpts: [{ src: { type: "ops", n: 3 }, speaker: "Tpr. Jordan Hale", quote: "I forgot to file it after the server restart. I've filed it now.", relevance: "Admission and remediation." }],
				location: "Paleto Bay.", locationSrc: [{ type: "ops", n: 2 }]
			},
			violations: ["Failure to File Use-of-Force Report"],
			conclusion: "The trooper acknowledged the omission and filed the report late. This is an administrative failure and a verbal warning is sufficient.",
			ai: { finding: "sustained", punishment: "verbal_warning", appealable: false, rationale: "Administrative omission, admitted and remediated. Counselling is sufficient. (Confidence: high.)" },
			sign: { by: brooks.id, finding: "sustained", punishment: "verbal_warning", appealable: false, statement: "Administrative. Remediated by the member.", notice: "Use-of-force reports must be filed before end of shift. This counselling is recorded on your IA file and is not appealable." }
		});

		// Case 5: appealed demotion.
		const t6 = makeTicket({
			type: "report", opener: cortez, subject: p.whitaker, daysAgo: 20,
			intake: { subjectGiven: "Cpl. Sam Whitaker", allegation: "Falsified patrol log", when: "5 Sep", location: "Sandy Shores station", details: "Whitaker logged 3 hours of patrol while AFK in station." },
			lines: [
				[bot, "Report received. Subject: Cpl. Sam Whitaker."],
				[cortez, "Whitaker logged a three hour patrol on 5 Sep but his character sat AFK in the Sandy Shores station the whole time. Two of us saw it."],
				[mercer, "Do you have timestamps?"],
				[cortez, "From 19:05 to about 22:10 server time."]
			]
		});
		const c5 = makeCase({
			tickets: [t6], title: "Falsified patrol log: Cpl. Sam Whitaker", subject: p.whitaker, reporter: cortez, anonymous: false,
			status: "appealed", daysAgo: 18, agent: mercer.id, incidentAt: "5 Sep 19:05-22:10", location: "Sandy Shores station",
			narrative: {
				summary: "Cpl. Sam Whitaker allegedly logged a three-hour patrol on 5 September while his character remained AFK at the Sandy Shores station.",
				summarySrc: [{ type: "report", n: 2 }],
				timeline: [{ when: "5 Sep 19:05-22:10", event: "Subject's character reportedly AFK in station while patrol time was logged.", src: [{ type: "report", n: 2 }, { type: "report", n: 4 }] }],
				excerpts: [{ src: { type: "report", n: 2 }, speaker: "Tpr. Alyssa Cortez", quote: "Whitaker logged a three hour patrol on 5 Sep but his character sat AFK in the Sandy Shores station the whole time.", relevance: "Core allegation." }],
				location: "Sandy Shores SAHP station.", locationSrc: [{ type: "report", n: 2 }]
			},
			violations: ["Falsification of Records", "Dishonesty"],
			conclusion: "After reviewing the reporting party's account and the timestamps provided, it is clear to me that Corporal SWhitaker01 logged patrol time while inactive in station. Falsifying official records is a dishonesty offence and a demotion to Trooper is appropriate.",
			ai: { finding: "sustained", punishment: "demotion", detail: "Corporal to Trooper", appealable: true, rationale: "Falsifying patrol records is a dishonesty offence. Two witnesses are referenced. (Confidence: medium.)" },
			sign: { by: voss.id, finding: "sustained", punishment: "demotion", detail: "Corporal to Trooper", appealable: true, statement: "Dishonesty in official records.", notice: "You are demoted from Corporal to Trooper for falsifying a patrol log on 5 September. You may appeal." }
		});
		db.prepare("INSERT INTO appeals (case_id, requested_by, reason, status, created_at, resolved_by, resolved_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)")
			.run(c5.id, "900000000000000077", "My game crashed and I was reconnecting for most of that window. I have client logs showing the disconnects.", now() - 4 * DAY, voss.id, now() - 3 * DAY);

		// Case 6: OPS system error.
		const t7 = makeTicket({
			type: "ops", opener: mercer, daysAgo: 1,
			intake: { summary: "CAD shows units as available while on calls", system: "CAD / MDT", when: "Since 24 Sep update", details: "Unit status resets to 10-8 after each server restart." },
			lines: [
				[bot, "OPS report received."],
				[mercer, "Since the 24 Sep update, the CAD resets every unit to 10-8 (available) after each server restart even if they're on a call."],
				[brooks, "Confirmed, saw it twice last night. Dispatch sent a unit that was mid-arrest."]
			]
		});
		makeCase({
			tickets: [t7], kind: "ops", title: "CAD unit status reset after restarts", reporter: mercer, anonymous: false,
			status: "marked_for_review", daysAgo: 1, incidentAt: "Since 24 Sep", location: "CAD / MDT",
			narrative: {
				summary: "Since the 24 September update, the CAD system resets all unit statuses to available (10-8) after each server restart, including units on active calls. A supervisor confirmed that dispatch sent a unit that was mid-arrest.",
				summarySrc: [{ type: "ops", n: 2 }, { type: "ops", n: 3 }],
				timeline: [
					{ when: "24 Sep", event: "Update deployed; status reset behaviour begins.", src: [{ type: "ops", n: 2 }] },
					{ when: "Night before report", event: "Supervisor observes two resets; a mid-arrest unit is dispatched.", src: [{ type: "ops", n: 3 }] }
				],
				excerpts: [{ src: { type: "ops", n: 3 }, speaker: "Lt. Daniel Brooks", quote: "Confirmed, saw it twice last night. Dispatch sent a unit that was mid-arrest.", relevance: "Supervisor corroboration and operational impact." }]
			},
			ai: { finding: "policy_failure", punishment: "no_action", appealable: false, rationale: "System defect, not member conduct. Refer to development staff. (Confidence: high.)" }
		});

		// Ticket inbox: a closed interview not yet attached, and an open report.
		makeTicket({
			type: "interview", opener: mercer, subject: p.whitaker, daysAgo: 1,
			intake: { reason: "Witness statement re: radio conduct (Sgt. Reyes)" },
			lines: [
				[bot, "Internal Affairs interview opened. Interviewing investigator: Det. Owen Mercer."],
				[mercer, "Cpl. Whitaker, were you on SAHP-1 on 3 September when Sgt. Reyes spoke to a probationary trooper about running plates?"],
				[{ id: "900000000000000077", name: "Cpl. Sam Whitaker" }, "Yes. He told the probie to go back to the academy. It was harsh but I didn't think it was my place to step in."]
			]
		});
		makeTicket({
			type: "report", opener: { id: "900000000000000051", name: "Tpr. Nia Okafor" }, subject: p.park, daysAgo: 0.2, closed: false,
			intake: { subjectGiven: "Tpr. Devin Park", allegation: "Unsafe driving in convoy", when: "Today", location: "Route 68", details: "Pending." },
			lines: [[bot, "Report received. Subject: Tpr. Devin Park."]]
		});

		setSetting("demo_seeded", true, null);
	})();
	console.log("[seed] demo data created");
}

function purgeDemo() {
	return db.transaction(() => {
		const caseIds = db.prepare("SELECT id FROM cases WHERE demo = 1").all().map(r => r.id);
		for (const id of caseIds) db.prepare("DELETE FROM cases_fts WHERE case_id = ?").run(id);
		const removed = {
			cases: db.prepare("DELETE FROM cases WHERE demo = 1").run().changes,
			tickets: db.prepare("DELETE FROM tickets WHERE demo = 1").run().changes,
			personnel: db.prepare("DELETE FROM personnel WHERE demo = 1 AND id NOT IN (SELECT subject_personnel_id FROM cases WHERE subject_personnel_id IS NOT NULL)").run().changes,
			users: db.prepare("DELETE FROM users WHERE demo = 1").run().changes
		};
		db.prepare("DELETE FROM jobs WHERE status IN ('done','failed')").run();
		return removed;
	})();
}

module.exports = { seedDemo, purgeDemo, USERS };
