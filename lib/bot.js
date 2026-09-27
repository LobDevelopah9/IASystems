const fs = require("fs");
const path = require("path");
const {
	Client, GatewayIntentBits, Partials, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
	ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, SlashCommandBuilder, Events, MessageFlags
} = require("discord.js");
const config = require("./config");
const { db, now } = require("./db");
const { roleFromDiscord, effectiveRole, can } = require("./permissions");
const { discordSettings, roleMap } = require("./policy");
const tickets = require("./tickets");
const cases = require("./cases");
const audit = require("./audit");

const GOLD = 0xd4a531;
const state = { client: null, ready: false, error: null, tag: null, lastSync: null };

const commands = [
	new SlashCommandBuilder().setName("ia-panel").setDescription("Post the Internal Affairs intake panel in this channel (supervisors)."),
	new SlashCommandBuilder().setName("interview").setDescription("Open an interview / interrogation ticket with a member.")
		.addUserOption(o => o.setName("member").setDescription("Member to interview").setRequired(true))
		.addStringOption(o => o.setName("case").setDescription("Case number to attach to, e.g. 0644"))
		.addStringOption(o => o.setName("ticket").setDescription("Related ticket reference, e.g. T-0012 (links them)"))
		.addStringOption(o => o.setName("reason").setDescription("Short reason shown to the member")),
	new SlashCommandBuilder().setName("close").setDescription("Close this IA ticket and capture its transcript.")
		.addStringOption(o => o.setName("reason").setDescription("Closing note (internal)")),
	new SlashCommandBuilder().setName("link-tickets").setDescription("Link tickets so one merged case is drafted.")
		.addStringOption(o => o.setName("tickets").setDescription("Ticket references separated by spaces, e.g. T-0012 T-0013").setRequired(true)),
	new SlashCommandBuilder().setName("add").setDescription("Add a member to this IA ticket.")
		.addUserOption(o => o.setName("member").setDescription("Member to add").setRequired(true)),
	new SlashCommandBuilder().setName("case").setDescription("Get a portal link to a case (IA staff only).")
		.addStringOption(o => o.setName("ref").setDescription("Case number, e.g. 0644").setRequired(true))
].map(c => c.setDMPermission(false).toJSON());

// --- Member & role sync ------------------------------------------------------------

function syncMember(member) {
	if (!member?.user || member.user.bot) return;
	const roles = [...member.roles.cache.keys()];
	const mapped = roleFromDiscord(roles);
	const existing = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(member.id);
	const displayName = member.nickname || member.user.globalName || member.user.username;
	if (existing) {
		const before = effectiveRole(existing);
		db.prepare("UPDATE users SET username = ?, display_name = ?, discord_roles = ?, mapped_role = ?, in_guild = 1, updated_at = ? WHERE discord_id = ?")
			.run(member.user.username, displayName, JSON.stringify(roles), mapped, now(), member.id);
		const after = effectiveRole(db.prepare("SELECT * FROM users WHERE discord_id = ?").get(member.id));
		if (before !== after) audit.record(null, "user.role_sync", { type: "user", ref: member.id }, { from: before, to: after });
	} else if (mapped !== "none") {
		db.prepare(`INSERT INTO users (discord_id, username, display_name, avatar, discord_roles, mapped_role, in_guild, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
			.run(member.id, member.user.username, displayName, member.user.displayAvatarURL({ size: 128 }), JSON.stringify(roles), mapped, now(), now());
	}
	// Keep the personnel directory aligned with Discord identities.
	const person = db.prepare("SELECT id FROM personnel WHERE discord_id = ?").get(member.id);
	if (person) db.prepare("UPDATE personnel SET name = ?, updated_at = ? WHERE id = ?").run(displayName, now(), person.id);
	else if (mapped !== "none") {
		db.prepare("INSERT INTO personnel (discord_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(member.id, displayName, now(), now());
	}
}

async function fullSync() {
	const guild = await getGuild();
	if (!guild) return { ok: false, error: "Guild not available" };
	const members = await guild.members.fetch();
	members.forEach(syncMember);
	const present = new Set(members.keys());
	for (const user of db.prepare("SELECT discord_id FROM users WHERE in_guild = 1 AND demo = 0").all()) {
		if (!present.has(user.discord_id)) db.prepare("UPDATE users SET in_guild = 0, updated_at = ? WHERE discord_id = ?").run(now(), user.discord_id);
	}
	state.lastSync = now();
	return { ok: true, members: members.size };
}

async function getGuild() {
	const { guildId } = discordSettings();
	if (!state.ready || !guildId) return null;
	return state.client.guilds.cache.get(guildId) || state.client.guilds.fetch(guildId).catch(() => null);
}

async function guildRoles() {
	const guild = await getGuild();
	if (!guild) return [];
	const roles = await guild.roles.fetch();
	return [...roles.values()].filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position)
		.map(r => ({ id: r.id, name: r.name, color: r.hexColor }));
}

async function guildChannels() {
	const guild = await getGuild();
	if (!guild) return [];
	const channels = await guild.channels.fetch();
	return [...channels.values()].filter(Boolean)
		.filter(c => c.type === ChannelType.GuildCategory || c.type === ChannelType.GuildText)
		.map(c => ({ id: c.id, name: c.name, type: c.type === ChannelType.GuildCategory ? "category" : "text" }));
}

// --- Helpers -----------------------------------------------------------------------

function actorFor(member) {
	const row = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(member.id);
	if (row) return row;
	return {
		discord_id: member.id,
		username: member.user.username,
		display_name: member.nickname || member.user.globalName || member.user.username,
		mapped_role: roleFromDiscord([...member.roles.cache.keys()]),
		in_guild: 1
	};
}

function staffRoleIds() {
	const map = roleMap();
	return [...new Set([...(map.director || []), ...(map.supervisor || []), ...(map.investigator || [])])];
}

function portalLink(ref) {
	return `${config.PUBLIC_URL}/app#/cases/${encodeURIComponent(ref)}`;
}

async function logToChannel(content) {
	const { logChannelId } = discordSettings();
	if (!logChannelId || !state.ready) return;
	const channel = await state.client.channels.fetch(logChannelId).catch(() => null);
	if (channel?.isTextBased()) await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

async function createTicketChannel(guild, name, memberIds) {
	const { ticketCategoryId } = discordSettings();
	const overwrites = [
		{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
		{ id: state.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
		...staffRoleIds().filter(id => guild.roles.cache.has(id)).map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] })),
		...memberIds.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }))
	];
	return guild.channels.create({
		name,
		type: ChannelType.GuildText,
		parent: ticketCategoryId || undefined,
		permissionOverwrites: overwrites,
		reason: "SAHP Internal Affairs ticket"
	});
}

function closeRow() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId("ia:close").setLabel("Close ticket").setStyle(ButtonStyle.Danger)
	);
}

// --- Intake panel ------------------------------------------------------------------

function panelMessage() {
	const embed = new EmbedBuilder()
		.setColor(GOLD)
		.setTitle("SAHP Internal Affairs Group")
		.setDescription([
			"**Professional Standards Bureau**",
			"",
			"Use the buttons below to make a confidential report to Internal Affairs.",
			"",
			"**Report a Trooper**: report misconduct by a trooper or SAHP staff member.",
			"**Report Anonymously**: the same report, but your identity is never shown to the trooper you are reporting. Internal Affairs still records who filed it.",
			"**OPS / System Report**: internal system errors and other Office of Professional Standards matters.",
			"",
			"False or malicious reports are themselves a disciplinary matter."
		].join("\n"))
		.setThumbnail(`${config.PUBLIC_URL}/img/ia-seal.png`)
		.setFooter({ text: "Nothing you submit is posted publicly. Outcomes are recorded in the IA portal only." });
	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId("ia:open:report").setLabel("Report a Trooper").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId("ia:open:anon").setLabel("Report Anonymously").setStyle(ButtonStyle.Secondary),
		new ButtonBuilder().setCustomId("ia:open:ops").setLabel("OPS / System Report").setStyle(ButtonStyle.Secondary)
	);
	return { embeds: [embed], components: [row] };
}

function reportModal(anonymous) {
	const input = (id, label, style, required, placeholder, max) => new ActionRowBuilder().addComponents(
		new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max).setPlaceholder(placeholder)
	);
	return new ModalBuilder()
		.setCustomId(anonymous ? "ia:modal:anon" : "ia:modal:report")
		.setTitle(anonymous ? "Anonymous Trooper Report" : "Trooper Report")
		.addComponents(
			input("subject", "Trooper ROBLOX username (and rank)", TextInputStyle.Short, true, "e.g. PT Robin13031", 100),
			input("reporterRoblox", "Your ROBLOX username", TextInputStyle.Short, true, "e.g. spinosaurusfan2004", 60),
			input("allegation", "Violation(s)", TextInputStyle.Short, true, "e.g. Unprofessionalism, Reckless Driving", 150),
			input("whenWhere", "When and where (in-game)", TextInputStyle.Short, false, "e.g. Jul 23 ~9:14 PM EST, R13 near old SAHP", 150),
			input("details", "What happened + clip links", TextInputStyle.Paragraph, true, "Describe the incident and paste Medal/YouTube links. You can also upload files in the ticket.", 3000)
		);
}

function opsModal() {
	const input = (id, label, style, required, placeholder, max) => new ActionRowBuilder().addComponents(
		new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max).setPlaceholder(placeholder)
	);
	return new ModalBuilder().setCustomId("ia:modal:ops").setTitle("OPS / System Report").addComponents(
		input("summary", "Summary", TextInputStyle.Short, true, "e.g. CAD shows wrong unit status", 150),
		input("system", "System or process affected", TextInputStyle.Short, false, "e.g. MDT, roster, radio, ticket bot", 100),
		input("when", "When did it happen?", TextInputStyle.Short, false, "Date/time", 100),
		input("details", "Details", TextInputStyle.Paragraph, true, "What happened, what you expected, who was affected.", 3000)
	);
}

async function handleIntake(interaction) {
	const kind = interaction.customId.split(":")[2];
	const anonymous = kind === "anon";
	const type = kind === "ops" ? "ops" : "report";
	const field = id => {
		try {
			return interaction.fields.getTextInputValue(id).trim();
		} catch {
			return "";
		}
	};
	const intake = type === "ops"
		? { summary: field("summary"), system: field("system"), when: field("when"), details: field("details") }
		: { subjectGiven: field("subject"), reporterRoblox: field("reporterRoblox"), allegation: field("allegation"), when: field("whenWhere"), details: field("details") };

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const openCount = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE opener_id = ? AND status = 'open'").get(interaction.user.id).n;
	if (openCount >= 3) return interaction.editReply("You already have three open IA tickets. Please finish those first.");

	let subject = null;
	if (type === "report" && intake.subjectGiven) {
		const guild = interaction.guild;
		const needle = intake.subjectGiven.toLowerCase();
		// Match on ROBLOX username first (with or without a rank prefix), then Discord names.
		const bare = needle.replace(/^(pt|tpr|cpl|sgt|msgt|lt|capt|cmdr)\.?\s+/i, "");
		const known = db.prepare("SELECT * FROM personnel WHERE lower(roblox_username) = ? OR lower(name) = ? OR lower(discord_username) = ?").get(bare, needle, bare);
		const match = known ? null : guild.members.cache.find(m => [m.nickname, m.user.globalName, m.user.username].filter(Boolean)
			.some(n => {
				const x = n.toLowerCase();
				return x === needle || x === bare || x.split(/[\s|]+/).includes(bare);
			}));
		subject = known || tickets.findOrCreatePersonnel(match
			? { discordId: match.id, name: match.nickname || match.user.globalName || match.user.username }
			: { name: intake.subjectGiven });
		if (subject && !subject.roblox_username && !match) db.prepare("UPDATE personnel SET roblox_username = ? WHERE id = ?").run(bare, subject.id);
		if (subject && match && !subject.discord_username) db.prepare("UPDATE personnel SET discord_username = ? WHERE id = ?").run(match.user.username, subject.id);
		if (subject?.discord_id === interaction.user.id) return interaction.editReply("You cannot file a report against yourself.");
	}

	const displayName = interaction.member?.nickname || interaction.user.globalName || interaction.user.username;
	const ticket = tickets.openTicket({
		type,
		guildId: interaction.guildId,
		openerId: interaction.user.id,
		openerName: displayName,
		openerUsername: interaction.user.username,
		anonymous,
		subjectPersonnelId: subject?.id || null,
		subjectText: intake.subjectGiven || null,
		intake
	});
	const name = `${type === "ops" ? "ops" : anonymous ? "anon" : "report"}-${ticket.ref.toLowerCase()}`;
	let channel;
	try {
		channel = await createTicketChannel(interaction.guild, name, [interaction.user.id]);
	} catch (error) {
		db.prepare("DELETE FROM tickets WHERE id = ?").run(ticket.id);
		console.error("[bot] channel create failed", error);
		return interaction.editReply("I couldn't create your ticket channel. Please tell an IA supervisor. The bot may be missing permissions.");
	}
	tickets.setChannel(ticket.id, channel.id);
	await channel.setTopic(`SAHP IA ticket ${ticket.ref} · ${tickets.TYPE_LABELS[type]}${anonymous ? " · ANONYMOUS" : ""}`).catch(() => {});

	const embed = new EmbedBuilder().setColor(GOLD)
		.setTitle(`${ticket.ref} · ${tickets.TYPE_LABELS[type]}${anonymous ? " (Anonymous)" : ""}`)
		.setDescription(type === "ops"
			? `**Summary:** ${intake.summary}\n**System:** ${intake.system || "-"}\n**When:** ${intake.when || "-"}\n\n${intake.details}`
			: `**Accused:** ${intake.subjectGiven}\n**Reporter ROBLOX:** ${intake.reporterRoblox || "-"}\n**Violation(s):** ${intake.allegation}\n**When / where:** ${intake.when || "-"}\n\n${intake.details}`)
		.setFooter({ text: anonymous
			? "Anonymous report: the trooper you reported will never see your identity. Internal Affairs keeps it on file."
			: "An IA investigator will respond here. Upload any clips or screenshots in this channel." });
	await channel.send({
		content: `<@${interaction.user.id}> your report has been received.`,
		embeds: [embed],
		components: [closeRow()],
		allowedMentions: { users: [interaction.user.id] }
	});
	audit.record(actorFor(interaction.member), "ticket.open", { type: "ticket", ref: ticket.ref }, { type, anonymous });
	await logToChannel(`New IA ticket **${ticket.ref}** (${tickets.TYPE_LABELS[type]}${anonymous ? ", anonymous" : ""}) · <#${channel.id}>`);
	await interaction.editReply(`Your ticket is open: <#${channel.id}> (${ticket.ref}).`);
}

// --- Closing & transcript capture -------------------------------------------------------

async function downloadAttachment(ticket, seq, attachment) {
	if (attachment.size > config.ATTACHMENT_MAX_BYTES) return null;
	try {
		const response = await fetch(attachment.url, { signal: AbortSignal.timeout(20000) });
		if (!response.ok) return null;
		const buffer = Buffer.from(await response.arrayBuffer());
		const dir = path.join(config.DATA_DIR, "attachments", ticket.ref);
		fs.mkdirSync(dir, { recursive: true });
		const safe = `${seq}-${attachment.id}-${String(attachment.name || "file").replace(/[^\w.-]+/g, "_").slice(0, 80)}`;
		fs.writeFileSync(path.join(dir, safe), buffer);
		return path.join("attachments", ticket.ref, safe);
	} catch {
		return null;
	}
}

function messageRecord(m) {
	return {
		messageId: m.id,
		authorId: m.author.id,
		authorName: m.member?.nickname || m.author.globalName || m.author.username,
		isBot: m.author.bot,
		content: [m.content, ...m.embeds.map(e => [e.title, e.description, ...(e.fields || []).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join("\n"))].filter(Boolean).join("\n"),
		attachments: [...m.attachments.values()].map(a => ({ filename: a.name, size: a.size, contentType: a.contentType })),
		createdAt: m.createdTimestamp
	};
}

// Stores one message against its ticket (idempotent by Discord message ID) and saves its attachments.
async function storeMessage(ticket, m) {
	if (db.prepare("SELECT 1 FROM ticket_messages WHERE ticket_id = ? AND message_id = ?").get(ticket.id, m.id)) return false;
	const r = messageRecord(m);
	const seq = (db.prepare("SELECT MAX(seq) AS n FROM ticket_messages WHERE ticket_id = ?").get(ticket.id).n || 0) + 1;
	db.prepare(`INSERT INTO ticket_messages (ticket_id, seq, message_id, author_id, author_name, is_bot, content, attachments, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticket.id, seq, r.messageId, r.authorId, r.authorName, r.isBot ? 1 : 0, r.content, JSON.stringify(r.attachments), r.createdAt);
	for (const a of m.attachments.values()) {
		const stored = await downloadAttachment(ticket, seq, a);
		db.prepare("INSERT INTO ticket_attachments (ticket_id, seq, filename, content_type, size, stored_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(ticket.id, seq, a.name || "file", a.contentType || null, a.size || null, stored, now());
	}
	return true;
}

// Puts messages in chronological order and renumbers refs (T-0001#1, #2, ...) with attachments following.
const resequence = db.transaction(ticketId => {
	const rows = db.prepare("SELECT id, seq FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at, id").all(ticketId);
	db.prepare("UPDATE ticket_messages SET seq = -seq WHERE ticket_id = ?").run(ticketId);
	db.prepare("UPDATE ticket_attachments SET seq = -seq WHERE ticket_id = ?").run(ticketId);
	rows.forEach((row, index) => {
		db.prepare("UPDATE ticket_messages SET seq = ? WHERE id = ?").run(index + 1, row.id);
		db.prepare("UPDATE ticket_attachments SET seq = ? WHERE ticket_id = ? AND seq = ?").run(index + 1, ticketId, -row.seq);
	});
	db.prepare("UPDATE tickets SET message_count = ? WHERE id = ?").run(rows.length, ticketId);
});

// Live capture keeps the transcript even if history cannot be read at close; the close-time fetch fills any gaps.
async function captureTranscript(channelId, ticket) {
	const live = db.prepare("SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ?").get(ticket.id).n;
	let fetched = 0;
	let added = 0;
	try {
		const channel = await state.client.channels.fetch(channelId, { force: true });
		let before;
		for (let page = 0; page < 50; page++) {
			const batch = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
			if (!batch.size) break;
			fetched += batch.size;
			for (const m of [...batch.values()].reverse()) {
				if (await storeMessage(ticket, m)) added++;
			}
			before = batch.last().id;
			if (batch.size < 100) break;
		}
	} catch (error) {
		console.warn(`[bot] history fetch for ${ticket.ref} failed: ${error.message}`);
	}
	resequence(ticket.id);
	const total = db.prepare("SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ?").get(ticket.id).n;
	console.log(`[bot] transcript ${ticket.ref}: ${live} live, ${fetched} fetched (${added} new), ${total} stored`);
	return total;
}

const closing = new Set();

async function closeTicketChannel(interaction, reason) {
	const ticket = tickets.ticketByChannel(interaction.channelId);
	if (!ticket) return interaction.reply({ content: "This isn't an open IA ticket channel.", flags: MessageFlags.Ephemeral });
	const actor = actorFor(interaction.member);
	const isStaff = can(actor, "ticket.view");
	if (!isStaff && ticket.opener_id !== interaction.user.id) {
		return interaction.reply({ content: "Only IA staff or the person who opened this ticket can close it.", flags: MessageFlags.Ephemeral });
	}
	// Guard against double clicks and a /close racing the Close button.
	if (closing.has(ticket.id)) return interaction.reply({ content: "This ticket is already closing.", flags: MessageFlags.Ephemeral });
	closing.add(ticket.id);
	await interaction.reply({ content: "Closing ticket and capturing the transcript…" });
	try {
		const count = await captureTranscript(interaction.channelId, ticket);
		const outcome = tickets.closeTicket(ticket.id, actor, reason);
		console.log(`[bot] closed ${ticket.ref}: ${count} message(s) captured, ${outcome.action}${outcome.caseRef ? ` case #${outcome.caseRef}` : ""}`);
		const summary = outcome.action === "created" ? `Case **${outcome.caseRef}** created and queued for AI drafting.`
			: outcome.action === "extended" ? `Transcript added to case **${outcome.caseRef}**.`
			: outcome.action === "waiting" ? `Linked case will be drafted once ${outcome.open.join(", ")} close.`
			: "Transcript is waiting in the IA ticket inbox.";
		await logToChannel(`Ticket **${ticket.ref}** closed by ${actor.display_name || actor.username} · ${count} messages captured. ${summary}${outcome.caseRef ? `\n${portalLink(outcome.caseRef)}` : ""}`);
		await interaction.channel.send("Transcript captured. This channel will be deleted in 10 seconds.");
		setTimeout(() => interaction.channel.delete("IA ticket closed").catch(() => {}), 10000);
	} catch (error) {
		closing.delete(ticket.id);
		console.error("[bot] close failed", error);
		await interaction.followUp({ content: `Closing failed: ${error.message}. The ticket is still open.` }).catch(() => {});
	}
}

// --- Commands --------------------------------------------------------------------------

async function handleCommand(interaction) {
	const actor = actorFor(interaction.member);
	const reply = (content, ephemeral = true) => interaction.reply({ content, flags: ephemeral ? MessageFlags.Ephemeral : undefined, allowedMentions: { parse: [] } });

	switch (interaction.commandName) {
		case "ia-panel": {
			if (!can(actor, "case.decide")) return reply("Only IA supervisors can post the intake panel.");
			await interaction.channel.send(panelMessage());
			audit.record(actor, "bot.panel_posted", { type: "channel", ref: interaction.channelId });
			return reply("Intake panel posted.");
		}
		case "interview": {
			if (!can(actor, "case.create")) return reply("Only IA staff can open interviews.");
			const member = interaction.options.getMember("member");
			if (!member) return reply("That member isn't in this server.");
			const caseRef = interaction.options.getString("case");
			const relatedRef = interaction.options.getString("ticket");
			let targetCase = null;
			if (caseRef) {
				targetCase = cases.getCase(caseRef);
				if (!targetCase) return reply(`Case ${caseRef} not found.`);
			}
			const related = relatedRef ? tickets.getTicket(relatedRef) : null;
			if (relatedRef && !related) return reply(`Ticket ${relatedRef} not found.`);
			if (related && !targetCase) {
				// If the related ticket already belongs to a case, attach the interview to that case instead of linking.
				const owning = db.prepare("SELECT c.* FROM case_tickets ct JOIN cases c ON c.id = ct.case_id WHERE ct.ticket_id = ?").get(related.id);
				if (owning) targetCase = owning;
			}
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			const person = tickets.findOrCreatePersonnel({ discordId: member.id, name: member.nickname || member.user.globalName || member.user.username });
			if (person && !person.discord_username) db.prepare("UPDATE personnel SET discord_username = ? WHERE id = ?").run(member.user.username, person.id);
			const ticket = tickets.openTicket({
				type: "interview",
				guildId: interaction.guildId,
				openerId: interaction.user.id,
				openerName: actor.display_name || actor.username,
				openerUsername: interaction.user.username,
				subjectPersonnelId: person?.id,
				subjectText: person?.name,
				intake: { reason: interaction.options.getString("reason") || "", relatedTicket: related?.ref || null },
				targetCaseId: targetCase?.id || null
			});
			if (related && !targetCase) tickets.linkTickets([related.ref, ticket.ref], actor);
			const channel = await createTicketChannel(interaction.guild, `interview-${ticket.ref.toLowerCase()}`, [member.id, interaction.user.id]);
			tickets.setChannel(ticket.id, channel.id);
			await channel.setTopic(`SAHP IA ticket ${ticket.ref} · Interview`).catch(() => {});
			await channel.send({
				content: `<@${member.id}>`,
				embeds: [new EmbedBuilder().setColor(GOLD).setTitle(`${ticket.ref} · Internal Affairs Interview`)
					.setDescription(`You have been asked to attend an Internal Affairs interview.${interaction.options.getString("reason") ? `\n\n**Subject matter:** ${interaction.options.getString("reason")}` : ""}\n\nAnswer the investigator's questions truthfully and completely. This conversation is recorded as part of an IA case file.`)
					.setFooter({ text: `Interviewing investigator: ${actor.display_name || actor.username}` })],
				components: [closeRow()],
				allowedMentions: { users: [member.id] }
			});
			audit.record(actor, "ticket.open", { type: "ticket", ref: ticket.ref }, { type: "interview", case: targetCase?.ref || null, linked: related?.ref || null });
			return interaction.editReply(`Interview ticket ${ticket.ref} opened: <#${channel.id}>${targetCase ? ` (attached to ${targetCase.ref})` : related ? ` (linked with ${related.ref})` : ""}.`);
		}
		case "close":
			return closeTicketChannel(interaction, interaction.options.getString("reason"));
		case "link-tickets": {
			if (!can(actor, "case.create")) return reply("Only IA staff can link tickets.");
			const refs = interaction.options.getString("tickets").toUpperCase().match(/T-\d+/g) || [];
			try {
				const result = tickets.linkTickets(refs, actor);
				return reply(result.caseRef
					? `Linked ${result.tickets.join(", ")}. All are closed, so merged case ${result.caseRef} was created: ${portalLink(result.caseRef)}`
					: `Linked ${result.tickets.join(", ")}. One merged case will be drafted once every linked ticket is closed.`);
			} catch (error) {
				return reply(error.message);
			}
		}
		case "add": {
			const ticket = tickets.ticketByChannel(interaction.channelId);
			if (!ticket) return reply("This isn't an open IA ticket.");
			if (!can(actor, "ticket.view")) return reply("Only IA staff can add members.");
			const member = interaction.options.getMember("member");
			await interaction.channel.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
			audit.record(actor, "ticket.add_member", { type: "ticket", ref: ticket.ref }, { member: member.id });
			return reply(`Added <@${member.id}>.`, false);
		}
		case "case": {
			// Only a link, never content. The portal enforces access on its side as well.
			if (!can(actor, "case.view")) return reply("Only IA staff can look up cases.");
			const row = cases.getCase(interaction.options.getString("ref"));
			if (!row) return reply("Case not found.");
			return reply(`Case #${row.ref}: ${portalLink(row.ref)}`);
		}
		default:
			return reply("Unknown command.");
	}
}

// --- Lifecycle ---------------------------------------------------------------------------

async function registerCommands() {
	const { guildId } = discordSettings();
	if (!guildId) return;
	const guild = await state.client.guilds.fetch(guildId).catch(() => null);
	if (guild) await guild.commands.set(commands);
}

async function start() {
	if (!config.DISCORD_BOT_TOKEN) {
		state.error = "DISCORD_BOT_TOKEN not set";
		return;
	}
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		partials: [Partials.GuildMember]
	});
	state.client = client;

	client.once(Events.ClientReady, async () => {
		state.ready = true;
		state.error = null;
		state.tag = client.user.tag;
		console.log(`[bot] online as ${client.user.tag}`);
		try {
			await registerCommands();
			await fullSync();
		} catch (error) {
			state.error = `Startup sync failed: ${error.message}`;
			console.error("[bot]", error);
		}
	});
	// Invited after startup: register commands and sync roles straight away.
	client.on(Events.GuildCreate, guild => {
		if (guild.id !== discordSettings().guildId) return;
		console.log(`[bot] joined ${guild.name}, registering commands`);
		registerCommands().then(fullSync).catch(error => { state.error = `Setup after join failed: ${error.message}`; });
	});
	client.on(Events.MessageCreate, message => {
		if (!message.inGuild() || message.guildId !== discordSettings().guildId) return;
		const ticket = tickets.ticketByChannel(message.channelId);
		if (ticket && !closing.has(ticket.id)) storeMessage(ticket, message).catch(error => console.warn(`[bot] live capture ${ticket.ref} failed: ${error.message}`));
	});
	client.on(Events.GuildMemberUpdate, (_, member) => {
		if (member.guild.id === discordSettings().guildId) syncMember(member);
	});
	client.on(Events.GuildMemberAdd, member => {
		if (member.guild.id === discordSettings().guildId) syncMember(member);
	});
	client.on(Events.GuildMemberRemove, member => {
		if (member.guild.id !== discordSettings().guildId) return;
		db.prepare("UPDATE users SET in_guild = 0, updated_at = ? WHERE discord_id = ?").run(now(), member.id);
		db.prepare("UPDATE sessions SET revoked = 1 WHERE discord_id = ?").run(member.id);
	});
	client.on(Events.InteractionCreate, async interaction => {
		try {
			if (!interaction.inGuild() || interaction.guildId !== discordSettings().guildId) {
				if (interaction.isRepliable()) await interaction.reply({ content: "This bot only works in the SAHP server.", flags: MessageFlags.Ephemeral });
				return;
			}
			if (interaction.isChatInputCommand()) return await handleCommand(interaction);
			if (interaction.isButton()) {
				if (interaction.customId === "ia:open:report") return await interaction.showModal(reportModal(false));
				if (interaction.customId === "ia:open:anon") return await interaction.showModal(reportModal(true));
				if (interaction.customId === "ia:open:ops") return await interaction.showModal(opsModal());
				if (interaction.customId === "ia:close") return await closeTicketChannel(interaction, null);
			}
			if (interaction.isModalSubmit() && interaction.customId.startsWith("ia:modal:")) return await handleIntake(interaction);
		} catch (error) {
			console.error("[bot] interaction failed", error);
			const payload = { content: "Something went wrong handling that. Please tell an IA supervisor.", flags: MessageFlags.Ephemeral };
			if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
			else if (interaction.isRepliable()) interaction.reply(payload).catch(() => {});
		}
	});
	client.on(Events.Error, error => {
		state.error = error.message;
	});

	// Keep retrying so fixing the Discord developer settings brings the bot online without a redeploy.
	const login = async () => {
		try {
			await client.login(config.DISCORD_BOT_TOKEN);
		} catch (error) {
			const hint = /disallowed intents/i.test(error.message)
				? " (enable Server Members Intent and Message Content Intent in the Discord developer portal → Bot)"
				: /invalid token/i.test(error.message) ? " (check DISCORD_BOT_TOKEN)" : "";
			state.error = `Login failed: ${error.message}${hint}. Retrying every minute.`;
			console.error("[bot]", state.error);
			client.destroy().catch?.(() => {});
			setTimeout(login, 60000).unref();
		}
	};
	await login();
	// Periodic full re-sync keeps roles right even if gateway events are missed.
	setInterval(() => fullSync().catch(() => {}), 30 * 60000).unref();
}

function status() {
	return { configured: Boolean(config.DISCORD_BOT_TOKEN), online: state.ready, tag: state.tag, error: state.error, lastSync: state.lastSync };
}

function inviteUrl() {
	if (!config.DISCORD_CLIENT_ID) return null;
	const perms = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles
		| PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.EmbedLinks
		| PermissionFlagsBits.AttachFiles | PermissionFlagsBits.UseApplicationCommands;
	return `https://discord.com/oauth2/authorize?client_id=${config.DISCORD_CLIENT_ID}&scope=bot%20applications.commands&permissions=${perms}`;
}

module.exports = { start, status, inviteUrl, fullSync, guildRoles, guildChannels, registerCommands, commands, panelMessage, storeMessage, resequence };
