require("dotenv").config();

const OWNER_IDS = (process.env.OWNER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function isOwnerUser(userId) {
  return OWNER_IDS.includes(String(userId));
}

const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("OK");
});

app.get("/health", (req, res) => {
  res.send("HEALTHY");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Web serveris veikia ant porto " + PORT);
});

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require("discord.js");

const EPHEMERAL_FLAGS = 64;

// ===== REQUIRED ENV =====
const REQUIRED = ["DISCORD_TOKEN", "GUILD_ID", "STAFF_ROLE_ID", "LOG_CHANNEL_ID"];
for (const k of REQUIRED) {
  if (!process.env[k] || String(process.env[k]).trim() === "") {
    console.error(`❌ Missing .env value: ${k}`);
    process.exit(1);
  }
}

// ===== TICKET TYPES (Paid-tier) =====
const TICKET_TYPES = {
  support: {
    label: "Support",
    emoji: "🛠️",
    description: "Help / technical issues",
    categoryEnv: "SUPPORT_CATEGORY_ID", // optional
    modalTitle: "SUPPORT Ticket",
    questions: [
      { id: "q1", label: "What do you need help with?", style: "short", required: true, placeholder: "One sentence summary..." },
      { id: "q2", label: "What's the issue exactly?", style: "para", required: true, placeholder: "Steps, errors, screenshots, what you tried..." },
      { id: "q3", label: "Your @ / order reference (optional)", style: "short", required: false, placeholder: "If relevant..." },
    ],
  },
  buy: {
    label: "Buy",
    emoji: "💰",
    description: "Purchase / order",
    categoryEnv: "BUY_CATEGORY_ID",
    modalTitle: "BUY Ticket",
    questions: [
      { id: "q1", label: "What do you want to buy?", style: "short", required: true, placeholder: "Product/service name..." },
      { id: "q2", label: "Quantity / package", style: "short", required: true, placeholder: "How many / which bundle..." },
      { id: "q3", label: "Budget & payment method", style: "short", required: true, placeholder: "Example: PayPal, crypto..." },
      { id: "q4", label: "Extra notes (optional)", style: "para", required: false, placeholder: "Anything else..." },
    ],
  },
  question: {
    label: "Questions",
    emoji: "❓",
    description: "General questions",
    categoryEnv: "QUESTION_CATEGORY_ID",
    modalTitle: "QUESTION Ticket",
    questions: [
      { id: "q1", label: "What's your question?", style: "para", required: true, placeholder: "Type your question..." },
      { id: "q2", label: "Extra context (optional)", style: "para", required: false, placeholder: "Links / details..." },
    ],
  },
  partner: {
    label: "Partnership",
    emoji: "🤝",
    description: "Business / partnership",
    categoryEnv: "PARTNER_CATEGORY_ID",
    modalTitle: "PARTNERSHIP Ticket",
    questions: [
      { id: "q1", label: "What partnership are you proposing?", style: "para", required: true, placeholder: "What you offer / what you want..." },
      { id: "q2", label: "Links (server / socials)", style: "para", required: true, placeholder: "Paste links..." },
      { id: "q3", label: "Audience / terms (optional)", style: "para", required: false, placeholder: "Numbers, regions, conditions..." },
    ],
  },
};

// ===== OPTIONAL: limits =====
const ONE_ACTIVE_TICKET_PER_TYPE = true; // paid-style guard (per user per type)

// ===== Intents =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

async function fetchMe(guild) {
  return guild.members.me ?? (await guild.members.fetchMe());
}

function yn(v) {
  return v ? "✅ true" : "❌ false";
}

function slugifyUsername(name) {
  const base = String(name || "user")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return base || "user";
}

function makeChannelName(guild, type, username) {
  const base = `${type}-${slugifyUsername(username)}`.slice(0, 90);
  let name = base;
  let i = 2;
  while (guild.channels.cache.some((c) => c.name === name)) {
    name = `${base}-${i}`.slice(0, 90);
    i++;
  }
  return name;
}

function getOwnerIdFromTopic(topic) {
  const m = String(topic || "").match(/TicketOwner:(\d+)/);
  return m ? m[1] : null;
}
function getTypeFromTopic(topic) {
  const m = String(topic || "").match(/Type:([a-z]+)/);
  return m ? m[1] : null;
}
function getClaimFromTopic(topic) {
  const m = String(topic || "").match(/Claimed:(\d+)/);
  return m ? m[1] : null;
}
function setTopic({ ownerId, type, claimedId }) {
  const c = claimedId ? `|Claimed:${claimedId}` : "";
  return `TicketOwner:${ownerId}|Type:${type}${c}`;
}

function guildPerms(me) {
  const p = me.permissions;
  return {
    view: p.has(PermissionsBitField.Flags.ViewChannel),
    manageChannels: p.has(PermissionsBitField.Flags.ManageChannels),
    send: p.has(PermissionsBitField.Flags.SendMessages),
    readHistory: p.has(PermissionsBitField.Flags.ReadMessageHistory),
  };
}

async function fetchTranscriptText(channel, limit = 200) {
  const all = [];
  let lastId = null;

  while (all.length < limit) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, limit - all.length),
      before: lastId ?? undefined,
    });
    if (!batch.size) break;
    const arr = [...batch.values()];
    all.push(...arr);
    lastId = arr[arr.length - 1].id;
  }

  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = [];
  lines.push(`Transcript for #${channel.name}`);
  lines.push(`Channel ID: ${channel.id}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("------------------------------------------------------------");

  for (const msg of all) {
    const time = new Date(msg.createdTimestamp).toISOString();
    const author = `${msg.author?.tag || "Unknown"} (${msg.author?.id || "?"})`;

    let content = msg.content || "";
    if (msg.attachments?.size) {
      const att = [...msg.attachments.values()].map((a) => a.url).join(" ");
      content = content ? `${content}\n[Attachments] ${att}` : `[Attachments] ${att}`;
    }
    if (msg.embeds?.length) content += (content ? "\n" : "") + `[Embeds] ${msg.embeds.length}`;
    if (!content) content = "[No text content]";

    lines.push(`[${time}] ${author}: ${content}`);
  }

  lines.push("------------------------------------------------------------");
  return lines.join("\n");
}

function buildTicketEmbed({ type, user, answers, claimedId }) {
  const cfg = TICKET_TYPES[type] || { label: "Ticket", emoji: "🎫" };
  const embed = new EmbedBuilder()
    .setTitle(`${cfg.emoji || "🎫"} ${cfg.label || "Ticket"} Ticket`)
    .addFields({ name: "Owner", value: `<@${user.id}>`, inline: true })
    .setTimestamp();

  if (claimedId) embed.addFields({ name: "Claimed by", value: `<@${claimedId}>`, inline: true });

  (answers || []).forEach((a) => {
    embed.addFields({ name: a.label, value: a.value?.slice(0, 1024) || "-", inline: false });
  });

  embed.setFooter({ text: `Type: ${type} | Owner: ${user.id}` });
  return embed;
}

function ticketButtonsRow1({ claimedId }) {
  const claimLabel = claimedId ? "Unclaim" : "Claim";
  const claimStyle = claimedId ? ButtonStyle.Secondary : ButtonStyle.Secondary;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_claim_toggle").setLabel(claimLabel).setStyle(claimStyle),
    new ButtonBuilder().setCustomId("ticket_transcript").setLabel("Transcript").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close").setStyle(ButtonStyle.Danger)
  );
}

function ticketButtonsRow2() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_adduser").setLabel("Add user").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ticket_rename").setLabel("Rename").setStyle(ButtonStyle.Primary)
  );
}

async function createTicketChannel({ guild, user, type, answers }) {
  const me = await fetchMe(guild);
  const staffRoleId = String(process.env.STAFF_ROLE_ID).trim();
  const logId = String(process.env.LOG_CHANNEL_ID).trim();

  if (ONE_ACTIVE_TICKET_PER_TYPE) {
    const exists = guild.channels.cache.find((c) => {
      if (c.type !== ChannelType.GuildText) return false;
      const ownerId = getOwnerIdFromTopic(c.topic);
      const t = getTypeFromTopic(c.topic);
      return ownerId === user.id && t === type;
    });
    if (exists) return { already: true, channel: exists };
  }

  const cfg = TICKET_TYPES[type];
  const parentId = cfg?.categoryEnv ? process.env[cfg.categoryEnv]?.trim() : null;
  const parent = parentId ? guild.channels.cache.get(parentId) : null;
  const useParent = !!(parent && parent.type === ChannelType.GuildCategory);

  const channelName = makeChannelName(guild, type, user.username);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    ...(useParent ? { parent: parentId } : {}),
    topic: setTopic({ ownerId: user.id, type }),
  });

  await channel.permissionOverwrites.set([
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
    {
      id: staffRoleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageMessages,
      ],
    },
    {
      id: me.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageChannels,
      ],
    },
  ]);

  const embed = buildTicketEmbed({ type, user, answers, claimedId: null });

  await channel.send({
    content: `<@${user.id}> <@&${staffRoleId}>`,
    embeds: [embed],
    components: [ticketButtonsRow1({ claimedId: null }), ticketButtonsRow2()],
  });

  const logCh = guild.channels.cache.get(logId);
  if (logCh) logCh.send(`🎫 Created **${type}** ticket: ${channel} | owner: <@${user.id}>`);

  return { already: false, channel };
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "ticket-diag") {
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: "This only works in a server.", flags: EPHEMERAL_FLAGS });

      const me = await fetchMe(guild);
      const p = guildPerms(me);

      const staffRole = guild.roles.cache.get(String(process.env.STAFF_ROLE_ID).trim());
      const logCh = guild.channels.cache.get(String(process.env.LOG_CHANNEL_ID).trim());

      const types = Object.keys(TICKET_TYPES);
      const catLines = types.map((t) => {
        const envKey = TICKET_TYPES[t].categoryEnv;
        const id = envKey ? process.env[envKey]?.trim() : "";
        if (!id) return `${t.toUpperCase()}: (no category set)`;
        const ch = guild.channels.cache.get(id);
        return `${t.toUpperCase()}: ${ch && ch.type === ChannelType.GuildCategory ? "✅ ok" : "❌ missing/wrong"}`;
      });

      const msg =
        `**Bot guild permissions:**\n` +
        `ViewChannel: ${yn(p.view)}\nManageChannels: ${yn(p.manageChannels)}\nSendMessages: ${yn(p.send)}\nReadHistory: ${yn(p.readHistory)}\n\n` +
        `**STAFF_ROLE_ID:** ${staffRole ? "✅ found" : "❌ not found"}\n` +
        `**LOG_CHANNEL_ID:** ${logCh ? "✅ found" : "❌ not found"}\n\n` +
        `**Categories (optional):**\n${catLines.join("\n")}\n\n` +
        `**Transcript note:** If you want full message text in transcripts, enable Message Content Intent in Dev Portal and add GatewayIntentBits.MessageContent in code.`;

      return interaction.reply({ content: msg, flags: EPHEMERAL_FLAGS });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "ticket-setup") {
      const embed = new EmbedBuilder()
        .setTitle("🎫 Professional Ticket System")
        .setDescription(
          "Select a ticket type below. You'll answer a few questions, then a private ticket channel will be created.\n\n" +
            "**Tips:**\n• Provide clear details to get faster help\n• Do not share passwords or sensitive data"
        );

      const menu = new StringSelectMenuBuilder()
        .setCustomId("ticket_type")
        .setPlaceholder("Select ticket type…")
        .addOptions(
          Object.entries(TICKET_TYPES).map(([value, cfg]) => ({
            label: cfg.label,
            value,
            description: cfg.description,
            emoji: cfg.emoji,
          }))
        );

      const row = new ActionRowBuilder().addComponents(menu);
      return interaction.reply({ embeds: [embed], components: [row] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "ticket_type") {
      const type = interaction.values[0];
      const cfg = TICKET_TYPES[type];
      if (!cfg) return interaction.reply({ content: "Unknown ticket type.", flags: EPHEMERAL_FLAGS });

      const modal = new ModalBuilder().setCustomId(`ticket_modal_${type}`).setTitle(cfg.modalTitle);

      const rows = cfg.questions.slice(0, 5).map((q) => {
        const style = q.style === "para" ? TextInputStyle.Paragraph : TextInputStyle.Short;
        return new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(q.id)
            .setLabel(q.label)
            .setPlaceholder(q.placeholder || "")
            .setStyle(style)
            .setRequired(!!q.required)
            .setMaxLength(q.style === "para" ? 900 : 120)
        );
      });

      modal.addComponents(...rows);
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket_modal_")) {
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: "This only works in a server.", flags: EPHEMERAL_FLAGS });

      const type = interaction.customId.replace("ticket_modal_", "");
      const cfg = TICKET_TYPES[type];
      if (!cfg) return interaction.reply({ content: "Unknown ticket type.", flags: EPHEMERAL_FLAGS });

      const answers = cfg.questions.slice(0, 5).map((q) => ({
        label: q.label,
        value: interaction.fields.getTextInputValue(q.id) || "-",
      }));

      const res = await createTicketChannel({ guild, user: interaction.user, type, answers });

      if (res.already) {
        return interaction.reply({
          content: `⚠️ You already have an active **${type}** ticket: ${res.channel}`,
          flags: EPHEMERAL_FLAGS,
        });
      }

      return interaction.reply({
        content: `✅ Ticket created: ${res.channel}`,
        flags: EPHEMERAL_FLAGS,
      });
    }

    if (interaction.isButton()) {
      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: "Not a ticket channel.", flags: EPHEMERAL_FLAGS });
      }

      const ownerId = getOwnerIdFromTopic(channel.topic);
      const type = getTypeFromTopic(channel.topic);
      if (!ownerId || !type) {
        return interaction.reply({ content: "This channel is not recognized as a ticket.", flags: EPHEMERAL_FLAGS });
      }

      const staffRoleId = String(process.env.STAFF_ROLE_ID).trim();
      const isStaff = interaction.member?.roles?.cache?.has(staffRoleId);

      // Ticket opener (paliekam kitoms funkcijoms)
      const isTicketOwner = interaction.user.id === ownerId;

      // Bot owner(s) iš OWNER_IDS (global permission)
      const isBotOwner = isOwnerUser(interaction.user.id);

      if (interaction.customId === "ticket_claim_toggle") {
        if (!isStaff) return interaction.reply({ content: "Only staff can claim/unclaim.", flags: EPHEMERAL_FLAGS });

        const currentClaim = getClaimFromTopic(channel.topic);
        const newClaim = currentClaim ? null : interaction.user.id;

        await channel.setTopic(setTopic({ ownerId, type, claimedId: newClaim }));

        const msgs = await channel.messages.fetch({ limit: 50 });
        const firstBotMsg = msgs.find((m) => m.author?.id === client.user.id && m.components?.length);
        if (firstBotMsg) {
          await firstBotMsg
            .edit({
              components: [ticketButtonsRow1({ claimedId: newClaim }), ticketButtonsRow2()],
            })
            .catch(() => {});
        }

        return interaction.reply({
          content: newClaim ? `✅ Claimed by <@${newClaim}>` : `✅ Ticket unclaimed`,
          flags: EPHEMERAL_FLAGS,
        });
      }

      if (interaction.customId === "ticket_transcript") {
        if (!isTicketOwner && !isStaff) {
          return interaction.reply({ content: "Only the ticket owner or staff can export transcript.", flags: EPHEMERAL_FLAGS });
        }

        await interaction.reply({ content: "⏳ Generating transcript...", flags: EPHEMERAL_FLAGS });

        let transcriptText = "";
        try {
          transcriptText = await fetchTranscriptText(channel, 200);
        } catch (e) {
          transcriptText = `Transcript failed: ${e?.message || e}`;
        }

        const fileName = `transcript-${channel.name}.txt`;
        const attachment = new AttachmentBuilder(Buffer.from(transcriptText, "utf-8"), { name: fileName });

        const logCh = interaction.guild.channels.cache.get(String(process.env.LOG_CHANNEL_ID).trim());
        if (logCh) {
          await logCh
            .send({ content: `📄 Transcript exported: ${channel} (by <@${interaction.user.id}>)`, files: [attachment] })
            .catch(() => {});
        }

        return interaction.followUp({
          content: "✅ Transcript generated (also saved in logs).",
          files: [attachment],
          flags: EPHEMERAL_FLAGS,
        });
      }

      if (interaction.customId === "ticket_adduser") {
        if (!isTicketOwner && !isStaff) {
          return interaction.reply({ content: "Only the ticket owner or staff can add users.", flags: EPHEMERAL_FLAGS });
        }

        const modal = new ModalBuilder().setCustomId("ticket_adduser_modal").setTitle("Add user to ticket");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("user")
              .setLabel("User ID or @mention")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder("Example: 123456789012345678 or @username")
          )
        );

        return interaction.showModal(modal);
      }

      if (interaction.customId === "ticket_rename") {
        if (!isTicketOwner && !isStaff) {
          return interaction.reply({ content: "Only the ticket owner or staff can rename.", flags: EPHEMERAL_FLAGS });
        }

        const modal = new ModalBuilder().setCustomId("ticket_rename_modal").setTitle("Rename ticket");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("name")
              .setLabel("New channel name (without #)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder("Example: buy-avox-urgent")
              .setMaxLength(90)
          )
        );

        return interaction.showModal(modal);
      }

      // ✅ CLOSE: dabar gali tik OWNER_IDS (bot owneriai), ne ticket openeris
      if (interaction.customId === "ticket_close") {
        if (!isBotOwner) {
          return interaction.reply({ content: "❌ Only bot owner(s) can close this ticket.", flags: EPHEMERAL_FLAGS });
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket_close_confirm").setLabel("Confirm Close").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("ticket_close_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({
          content: "Are you sure you want to close this ticket?",
          components: [row],
          flags: EPHEMERAL_FLAGS,
        });
      }

      if (interaction.customId === "ticket_close_cancel") {
        return interaction.reply({ content: "✅ Close cancelled.", flags: EPHEMERAL_FLAGS });
      }

      if (interaction.customId === "ticket_close_confirm") {
        if (!isBotOwner) {
          return interaction.reply({ content: "❌ Only bot owner(s) can close this ticket.", flags: EPHEMERAL_FLAGS });
        }

        await interaction.reply({ content: "🔒 Closing in 5 seconds… generating transcript & sending DM.", flags: EPHEMERAL_FLAGS });

        let transcriptText = "";
        try {
          transcriptText = await fetchTranscriptText(channel, 200);
        } catch (e) {
          transcriptText = `Transcript failed: ${e?.message || e}`;
        }

        const fileName = `transcript-${channel.name}.txt`;
        const attachment = new AttachmentBuilder(Buffer.from(transcriptText, "utf-8"), { name: fileName });

        // DM ticket opener (original ownerId iš topic)
        let dmOk = true;
        try {
          const u = await client.users.fetch(ownerId);
          await u.send({
            content: `✅ Your ticket **#${channel.name}** has been closed. Here is the transcript:`,
            files: [attachment],
          });
        } catch {
          dmOk = false;
        }

        const logCh = interaction.guild.channels.cache.get(String(process.env.LOG_CHANNEL_ID).trim());
        if (logCh) {
          const note = dmOk
            ? `🔒 Ticket closed by bot owner <@${interaction.user.id}>. DM transcript ✅`
            : `🔒 Ticket closed by bot owner <@${interaction.user.id}>. DM transcript ❌ (DMs closed). Saved here ✅`;
          await logCh.send({ content: note, files: [attachment] }).catch(() => {});
        }

        setTimeout(() => channel.delete().catch(() => {}), 5000);
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === "ticket_adduser_modal") {
      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: "Not a ticket channel.", flags: EPHEMERAL_FLAGS });
      }

      const ownerId = getOwnerIdFromTopic(channel.topic);
      const staffRoleId = String(process.env.STAFF_ROLE_ID).trim();
      const isStaff = interaction.member?.roles?.cache?.has(staffRoleId);
      const isTicketOwner = interaction.user.id === ownerId;

      if (!isTicketOwner && !isStaff) {
        return interaction.reply({ content: "Not allowed.", flags: EPHEMERAL_FLAGS });
      }

      const raw = interaction.fields.getTextInputValue("user");
      const id = raw.replace(/[<@!>]/g, "").trim();

      let member = null;
      try {
        member = await interaction.guild.members.fetch(id);
      } catch {}

      if (!member) {
        return interaction.reply({ content: "❌ Could not find that user ID.", flags: EPHEMERAL_FLAGS });
      }

      await channel.permissionOverwrites.edit(member.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });

      return interaction.reply({ content: `✅ Added <@${member.id}> to this ticket.`, flags: EPHEMERAL_FLAGS });
    }

    if (interaction.isModalSubmit() && interaction.customId === "ticket_rename_modal") {
      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: "Not a ticket channel.", flags: EPHEMERAL_FLAGS });
      }

      const ownerId = getOwnerIdFromTopic(channel.topic);
      const staffRoleId = String(process.env.STAFF_ROLE_ID).trim();
      const isStaff = interaction.member?.roles?.cache?.has(staffRoleId);
      const isTicketOwner = interaction.user.id === ownerId;

      if (!isTicketOwner && !isStaff) {
        return interaction.reply({ content: "Not allowed.", flags: EPHEMERAL_FLAGS });
      }

      const name = interaction.fields.getTextInputValue("name").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 90);
      if (!name || name.length < 2) {
        return interaction.reply({ content: "❌ Invalid name.", flags: EPHEMERAL_FLAGS });
      }

      await channel.setName(name).catch(() => {});
      return interaction.reply({ content: `✅ Renamed ticket to **#${name}**`, flags: EPHEMERAL_FLAGS });
    }
  } catch (e) {
    console.error("❌ Runtime error:", e);
    if (interaction.isRepliable()) {
      interaction.reply({ content: "An error occurred. Check the terminal.", flags: EPHEMERAL_FLAGS }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch((e) => console.error("❌ Login error:", e?.message || e));
