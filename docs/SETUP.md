# SAHP IA System: setup tasks

The code, hosting, database volume, domain, and base configuration are done. These are the steps only you can do, because they need your Discord and Google/Groq accounts. Allow about 30 minutes.

**Portal URL:** https://sandyshores.dev/sahp/opr/ia/ (served through the Sandy Moderation Panel; the raw Railway domain returns 404)
**Railway project:** IA Systems (SAHP) → service `IASystems` → **Variables** tab

---

## 1. Create the Discord application (bot + sign-in)

One application serves both the IA bot and "Sign in with Discord".

1. Go to https://discord.com/developers/applications and click **New Application**. Name it e.g. `SAHP Internal Affairs`. You can upload `public/img/ia-seal.png` as its icon.
2. **General Information** → copy the **Application ID** (this is the client ID).
3. **OAuth2** → **Client Secret** → **Reset Secret** → copy it.
4. **OAuth2** → **Redirects** → **Add Redirect**, paste exactly this, then save:
   ```
   https://sandyshores.dev/sahp/opr/ia/auth/callback
   ```
5. **Bot** → **Reset Token** → copy the bot token.
6. On the same **Bot** page, under **Privileged Gateway Intents**, turn on:
   - **Server Members Intent** (role sync, so access follows Discord roles)
   - **Message Content Intent** (needed to capture ticket transcripts)

   Save changes.
7. Still on **Bot**, turn **Public Bot** off so nobody else can invite it.

## 2. Get the IDs you need from Discord

Turn on **User Settings → Advanced → Developer Mode**, then right-click → **Copy ID** for:

- The **SAHP server** (right-click the server icon)
- **Your own user** (you become the break-glass Head of IA)

Optionally, create now (or pick later from a dropdown in the portal):

- A private category for IA tickets, e.g. `IA TICKETS`, visible only to IA staff
- A private staff channel for IA notifications, e.g. `#ia-log`. It only ever gets ticket events and portal links, never case content.

## 3. Get a free AI key

Pick one. The portal is already set to **Gemini**.

| Provider | Where | Notes |
| --- | --- | --- |
| **Google Gemini** (recommended, already selected) | https://aistudio.google.com/apikey → **Create API key** | Generous free tier and a large context window, so long tickets fit. On the free tier Google may use prompts to improve its products. |
| **Groq** | https://console.groq.com/keys | Free, very fast, and does not train on your data. Per-minute token limits are lower, so very long tickets may need a retry. Set `AI_PROVIDER=groq`. |

**Backup (recommended):** also create a Groq key at https://console.groq.com/keys and set it as `AI_FALLBACK_API_KEY`. When Gemini is overloaded or failing, drafts switch to Groq automatically. The best available Groq model is picked for you, and `AI_FALLBACK_MODEL` pins a specific one.

## 4. Add the variables in Railway

Railway → IA Systems (SAHP) → `IASystems` → **Variables** → **New Variable**. Add:

| Variable | Value |
| --- | --- |
| `DISCORD_CLIENT_ID` | Application ID from step 1.2 |
| `DISCORD_CLIENT_SECRET` | Client secret from step 1.3 |
| `DISCORD_BOT_TOKEN` | Bot token from step 1.5 |
| `DISCORD_GUILD_ID` | SAHP server ID |
| `IA_OWNER_DISCORD_IDS` | Your Discord user ID (comma-separate if more than one person) |
| `AI_API_KEY` | Key from step 3 |
| `AI_PROVIDER` | Already `gemini`. Change to `groq` if you picked Groq. |

Already set, leave as is: `NODE_ENV`, `PORT`, `DATA_DIR`, `PUBLIC_URL`, `SESSION_SECRET`, `SEED_DEMO`.

Railway redeploys automatically after you save.

## 5. Invite the bot

Sign in at https://sandyshores.dev/sahp/opr/ia/ with Discord. As an owner, you land on the board as Head of IA.

Go to **Settings → System status** and click **Invite the bot to the SAHP server**. Keep all requested permissions. The bot needs Manage Channels and Manage Roles to create private ticket channels.

In Discord **Server Settings → Roles**, drag the bot's role **above** the IA staff roles, so it can grant them access to ticket channels.

## 6. Configure the portal

In **Settings → Discord & roles**:

1. Confirm the server ID, then choose the **ticket category** and **IA log channel** from the dropdowns. Save.
2. **Role mapping.** Tick which Discord roles map to each portal role:
   - **Head of Internal Affairs**: IA command
   - **OPS Supervisor**: whoever signs and approves cases
   - **IA Investigator**: IA agents who work cases
   - **Trooper**: every SAHP member role, so troopers can see their own determinations and appeal

   Save. Everyone re-syncs immediately.

In **Settings → Punishment policy**:

3. Check the punishment categories (Verbal Warning, FTO, Black Mark, Suspension, Demotion, Termination, Blacklist, No Action). Adjust names, severities, default appealability, and descriptions to match the SAHP disciplinary guidelines exactly. The AI follows these descriptions.
4. **Case numbering.** The next case is **#0644**. If more paper cases were written after #0643, raise this number.

In **Users & Agents**:

5. Open each IA agent (**Manage**) and fill in their **ROBLOX username** and **title** (e.g. Assistant Commissioner). These appear as Investigator and "Approved & Processed By" on reports.

## 7. Post the intake panel

In the Discord channel where members should file reports, run:

```
/ia-panel
```

The panel has three buttons: **Report a Trooper**, **Report Anonymously**, and **OPS / System Report**.

## 8. Do one test run

1. Click **Report a Trooper** and file a test report against a test account.
2. In the ticket, reply as an IA agent, and paste a Medal link.
3. Open an interview with `/interview member:@test ticket:T-000X`, answer a question, then `/close` both tickets.
4. Within a minute a merged case appears in **Review Queue** with a drafted Investigation Report and the clip listed under Evidence.
5. Open it, check the draft, **Sign & approve**, then **Close**.
6. Sign in as the test trooper. They see only the determination and the notice to the member.

If the AI draft fails, **Settings → System status → Test connection** shows the provider error.

## 9. Go live

1. **Settings → System status → Purge demo data** (type `PURGE DEMO DATA`).
2. In Railway, set `SEED_DEMO` to `false`.

## Discord commands (for IA staff)

| Command | Use |
| --- | --- |
| `/ia-panel` | Post the intake panel (supervisors) |
| `/interview member [case] [ticket] [reason]` | Open an interview/statement ticket. Use `case:0644` to add it to an existing case, or `ticket:T-0012` to merge it with that report. |
| `/close [reason]` | Capture the transcript and close the ticket |
| `/link-tickets T-0012 T-0013` | Merge tickets into one case when they all close |
| `/add member` | Add someone to a ticket |
| `/case 0644` | Private portal link to a case |
