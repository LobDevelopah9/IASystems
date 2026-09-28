# SAHP Internal Affairs System

Case management for the **San Andreas Highway Patrol (SAHP) Internal Affairs Group, Professional Standards Bureau**.

One Node.js 22 service runs three parts:

| Part | What it does |
| --- | --- |
| **IA portal** | Discord sign-in, case board, review queue, read-only case file, supervisor editor and signing, ticket inbox, users & agents, audit log, settings. |
| **IA Discord bot** | Intake panel (report a trooper, report anonymously, OPS/system report), interview tickets, transcript capture on close, `/link-tickets`, role sync. |
| **AI drafting pipeline** | Turns closed ticket transcripts into a draft **Investigation Report** in the Office of Professional Standards format (Ticket Details, Accused Trooper's Statement, Conclusion, evidence, investigation conclusion), written in the investigator's first-person voice, with every section cited to ticket messages. The punishment **decision** is stored separately and is a recommendation only. |

Hosting: Railway project **IA Systems (SAHP)**, in the same workspace as the Sandy Shores moderation panel but a separate project and repo.

> Setup steps you need to complete are in **[docs/SETUP.md](docs/SETUP.md)**.

## Investigation Reports

Every case renders as the OPS paper format used before the portal (see Case #0642 and #0643): letterhead, case number, investigator(s), case classification, accused violations, accused and accuser contact information (ROBLOX, Discord, rank, department), Investigation Description, Investigation Evidence, and the Investigation Conclusion block. Once a supervisor signs, the block fills in "Does the evidence support the allegation(s)", "Punishment(s) Issued", "Date Investigation Was Closed", and "Investigation Approved & Processed By" automatically.

* **Case numbers** continue the paper series. The first portal case is **#0644**. The next number can be changed in **Settings → Punishment policy**. Demo cases use #9001 and up, so they never use up real numbers.
* **Punishments can be combined**, e.g. X1 Black Mark + FTO, or Termination + Blacklist.
* **Evidence links** (Medal, YouTube, Streamable, and similar) and uploaded files are pulled from the transcripts automatically, never from the AI.
* **One accused per case.** When a report names several troopers, open one case per accused on the same tickets. The cases are cross-linked as related cases, and each trooper keeps their own record, determination, and appeal.

## Case lifecycle

```
Discord ticket ──close──▶ transcript captured ──▶ AI draft ──▶ Marked for Review
                                                                  │
                        ┌─────────── send back ◀──────────────────┤
                        ▼                                         ▼
               Under Investigation ──submit──▶ Marked for Review ──sign──▶ Approved ──▶ Closed
                                                                            │            │
                                                                            └─▶ Appealed ◀┘ (director)
```

* Every case starts in **Marked for Review**, including cases drafted entirely by the AI.
* **Approved** is only reachable through a supervisor signature. **Closed** requires a current, valid signature.
* A signature records a SHA-256 hash of the case content. Editing signed content afterwards requires a reason, flags the signature as **invalidated**, and sends an approved case back to review. Signatures, AI recommendations, and the audit log are immutable at the database level (SQLite triggers).

## Roles

Portal roles come from Discord roles (mapped in **Settings → Discord & roles**). A director can override any individual on the **Users & Agents** page.

| Capability | Trooper | Investigator | Supervisor | Head of IA |
| --- | :-: | :-: | :-: | :-: |
| See own approved determinations, request an appeal | ✓ | ✓ | ✓ | ✓ |
| Case board, tickets, transcripts (including anonymous reporters), notes, New Case, edit reports, AI redraft | | ✓ | ✓ | ✓ |
| Sign & approve, set punishment, close, hear appeals, assign agents | | | ✓ | ✓ |
| Audit log, view users | | | ✓ | ✓ |
| Manage users (overrides, suspension, sessions), settings, reopen closed cases | | | | ✓ |

Hard rules enforced on the server regardless of role:

* **Subjects never see their own investigation.** If you are the subject of a case, you only ever get the member view (determination + notice to member), even if you are IA staff. Such cases are hidden from your board, ticket inbox, and search.
* **Recusal.** Nobody can act on a case they are the subject of or filed the report for.
* **Owner override.** Accounts in `IA_OWNER_DISCORD_IDS` bypass recusal and the subject rules (they can open, view, and act on cases they filed or are accused in, and report themselves for testing). Every case view, status change, and signature made under the override is flagged `ownerOverride` in the audit log.
* **Anonymity.** An anonymous report is anonymous *to the accused*. The reporter is named in the Investigation Report and is visible to every IA agent. The accused only ever gets the member view, which never contains the reporter, the report text, the transcripts, or the AI output.
* **Last director.** The portal refuses changes that would leave it without a Head of IA. Owners in `IA_OWNER_DISCORD_IDS` are always directors and cannot be suspended.
* Suspension, lowering a role, or leaving the Discord server revokes sessions immediately.

## Containment

The case file never leaves the system as a portable artifact.

* No export, print, PDF, or copy features exist. `Ctrl+P`/`Ctrl+S` are blocked, print CSS blanks the page, text selection, right-click, drag, copy, and cut are disabled on all case material, including the editor.
* A tiled watermark with the viewer's name, Discord ID, and time is drawn over every case file and transcript.
* A privacy shield blurs case material whenever the window loses focus (snipping tools, window switching) or on PrintScreen.
* All API responses are `no-store`. Attachments are served only inline, through an authenticated, audited route.
* Every case view, transcript view, attachment view, edit, signature, status change, sign-in, and denied access is written to a hash-chained audit log. You can check it with **Audit Log → Verify integrity**.

**PDF export exception.** Only the Discord IDs in `IA_EXPORT_DISCORD_IDS` see a **Download PDF** button. It produces the Investigation Report in the OPS document format. Every export is written to the audit log (`case.export`), and every page is stamped with the exporter and the time.

True screenshot prevention is impossible in a browser. These controls remove the sanctioned exits and make any leak traceable to the viewer.

## Discord commands

| Command | Who | Purpose |
| --- | --- | --- |
| `/ia-panel` | Supervisor+ | Posts the intake panel with the three report buttons. |
| `/interview member [case] [ticket] [reason]` | Investigator+ | Opens an interview ticket. With `case`, the transcript is added to that case on close. With `ticket`, it links to that report so one merged case is drafted when both close. |
| `/close [reason]` | IA staff or ticket opener | Captures the full transcript and attachments, routes it to a case, deletes the channel. |
| `/link-tickets tickets` | Investigator+ | Pre-links tickets (e.g. `T-0012 T-0013`) so the AI drafts one merged case. |
| `/add member` | Investigator+ | Adds someone to the current ticket. |
| `/case ref` | Investigator+ | Replies privately with a portal link. Never case content. |

The bot never posts punishments, verdicts, or case content into Discord. The IA log channel receives ticket events and portal links only.

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:3000. Outside production, demo data is seeded and the login page lists demo accounts for each role (`/auth/dev` is disabled when `NODE_ENV=production`).

```bash
npm test
```

The tests cover the permission gates, anonymity redaction, signature invalidation, immutability triggers, audit chain, session revocation, and the AI pipeline end to end against a mock model.

## Project layout

```
index.js              boot: web server, AI worker, Discord bot
lib/config.js         environment variables
lib/db.js             SQLite schema, immutability triggers, FTS search index
lib/permissions.js    roles and capabilities
lib/auth.js           Discord OAuth2 (PKCE), sessions, CSRF guard
lib/cases.js          case rules: access, recusal, transitions, signing, search
lib/tickets.js        ticket storage, transcript redaction, routing closed tickets to cases
lib/ai.js             provider adapters (Gemini, Groq, OpenAI-compatible, Ollama), prompt, output validation
lib/pipeline.js       durable job queue for AI drafting
lib/bot.js            Discord bot
lib/policy.js         findings, punishment categories, role map, Discord settings
lib/seed.js           demo data and purge
routes/api.js         JSON API
public/               portal UI (no build step)
```
