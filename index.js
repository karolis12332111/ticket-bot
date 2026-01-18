require("dotenv").config();
console.log("BOOT: index.js start");
console.log("ENV DISCORD_TOKEN length:", process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.length : 0);
console.log("ENV GUILD_ID:", process.env.GUILD_ID ? "OK" : "MISSING");
console.log("ENV STAFF_ROLE_ID:", process.env.STAFF_ROLE_ID ? "OK" : "MISSING");
console.log("ENV LOG_CHANNEL_ID:", process.env.LOG_CHANNEL_ID ? "OK" : "MISSING");


// ===== BOT OWNERS (ONLY THESE CAN MANAGE TICKETS) =====
const OWNER_IDS = (process.env.OWNER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isBotOwner(userId) {
  return OWNER_IDS.includes(String(userId));
}

// ===== WEB SERVER (Render/UptimeRobot) =====
const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.send("HEALTHY"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Web serveris veikia ant porto " + PORT));

// ===== DISCORD =====
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

// ===== REQUIRED ENV =====
const REQUIRED = ["DISCORD_TOKEN", "GUILD_ID", "STAFF_ROLE_ID", "LOG_CHANNEL_ID", "OWNER_IDS"];
for (const k of REQUIRED) {
  if (!process.env[k] || String(process.env[k]).trim() === "") {
    console.error(`❌ Missing .env value: ${k}`);
    process.exit(1);
  }
}
if (!OWNER_IDS.length) {
  console.error("❌ OWNER_IDS is empty. Add OWNER_IDS in .env (comma-separated Discord IDs).");
  process.exit(1);
}

// ===== TICKET TYPES =====
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

const ONE_ACTIVE_TICKET_PER_TYPE = true;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once("ready", () => console.log(`✅ Logged in as ${client.user.tag} (${client.user.id})`));

async function fetchMe(guild) {
  return guild.members.me ?? (await guild.members.fetchMe());
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
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_claim_toggle").setLabel(claimLabel).setStyle(ButtonStyle.Secondary),
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
  if (logCh) logCh.send(`🎫 Created **${type}** ticket: ${channel} | owner: <@${user.id}>`).catch(() => {});

  return { already: false, channel };
}

function ensureBotOwner(interaction) {
  if (isBotOwner(interaction.user.id)) return true;
  interaction.reply({ content: "❌ Not allowed (owners only).", ephemeral: true }).catch(() => {});
  return false;
}

client.on("interactionCreate", async (interaction) => {
  try {
    // /ticket-setup
    if (interaction.isChatInputCommand() && interaction.commandName === "ticket-setup") {
      const embed = new EmbedBuilder()
        .setTitle("🎫 Ticket System")
        .setDescription("Select a ticket type below. You'll answer a few questions and a private ticket will be created.");

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

      return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
    }

    // Select menu -> modal
    if (interaction.isStringSelectMenu() && interaction.customId === "ticket_type") {
      const type = interaction.values[0];
      const cfg = TICKET_TYPES[type];
      if (!cfg) return interaction.reply({ content: "Unknown ticket type.", ephemeral: true });

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

    // Modal submit -> create ticket
    if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket_modal_")) {
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: "This only works in a server.", ephemeral: true });

      // svarbu: kad nepamestų interactiono
      await interaction.deferReply({ ephemeral: true });

      const type = interaction.customId.replace("ticket_modal_", "");
      const cfg = TICKET_TYPES[type];
      if (!cfg) return interaction.editReply({ content: "Unknown ticket type." });

      const answers = cfg.questions.slice(0, 5).map((q) => ({
        label: q.label,
        value: interaction.fields.getTextInputValue(q.id) || "-",
      }));

      const res = await createTicketChannel({ guild, user: interaction.user, type, answers });

      if (res.already) {
        return interaction.editReply({
          content: `⚠️ You already have an active **${type}** ticket: ${res.channel}`,
        });
      }

      return interaction.editReply({ content: `✅ Ticket created: ${res.channel}` });
    }

    // Buttons (ONLY owners)
    if (interaction.isButton()) {
      if (!ensureBotOwner(interaction)) return;

      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: "Not a ticket channel.", ephemeral: true }).catch(() => {});
      }

      const ticketOwnerId = getOwnerIdFromTopic(channel.topic);
      const type = getTypeFromTopic(channel.topic);
      if (!ticketOwnerId || !type) {
        return interaction.reply({ content: "This channel is not recognized as a ticket.", ephemeral: true }).catch(() => {});
      }

      // BUTTONS THAT SHOW MODAL: do NOT deferReply before showModal
      if (interaction.customId === "ticket_adduser") {
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

      // For all other buttons, we defer (prevents timeout)
      await interaction.deferReply({ ephemeral: true });

      if (interaction.customId === "ticket_claim_toggle") {
        const currentClaim = getClaimFromTopic(channel.topic);
        const newClaim = currentClaim ? null : interaction.user.id;

        await channel.setTopic(setTopic({ ownerId: ticketOwnerId, type, claimedId: newClaim }));

        const msgs = await channel.messages.fetch({ limit: 50 });
        const firstBotMsg = msgs.find((m) => m.author?.id === client.user.id && m.components?.length);
        if (firstBotMsg) {
          await firstBotMsg.edit({ components: [ticketButtonsRow1({ claimedId: newClaim }), ticketButtonsRow2()] }).catch(() => {});
        }

        return interaction.editReply({
          content: newClaim ? `✅ Claimed by <@${newClaim}>` : `✅ Ticket unclaimed`,
        });
      }

      if (interaction.customId === "ticket_transcript") {
        await interaction.editReply({ content: "⏳ Generating transcript..." });

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
          await logCh.send({ content: `📄 Transcript exported: ${channel} (by <@${interaction.user.id}>)`, files: [attachment] }).catch(() => {});
        }

        return interaction.editReply({ content: "✅ Transcript generated (saved in logs too).", files: [attachment] });
      }

      if (interaction.customId === "ticket_close") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket_close_confirm").setLabel("Confirm Close").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("ticket_close_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );

        return interaction.editReply({
          content: "Are you sure you want to close this ticket?",
          components: [row],
        });
      }

      if (interaction.customId === "ticket_close_cancel") {
        return interaction.editReply({ content: "✅ Close cancelled.", components: [] });
      }

      if (interaction.customId === "ticket_close_confirm") {
        await interaction.editReply({ content: "🔒 Closing in 5 seconds… generating transcript & sending DM.", components: [] });

        let transcriptText = "";
        try {
          transcriptText = await fetchTranscriptText(channel, 200);
        } catch (e) {
          transcriptText = `Transcript failed: ${e?.message || e}`;
        }

        const fileName = `transcript-${channel.name}.txt`;
        const attachment = new AttachmentBuilder(Buffer.from(transcriptText, "utf-8"), { name: fileName });

        // DM ticket opener
        let dmOk = true;
        try {
          const u = await client.users.fetch(ticketOwnerId);
          await u.send({
            content: `✅ Your ticket **#${channel.name}** has been closed. Here is the transcript:`,
            files: [attachment],
          });
        } catch {
          dmOk = false;
        }

        // log backup
        const logCh = interaction.guild.channels.cache.get(String(process.env.LOG_CHANNEL_ID).trim());
        if (logCh) {
          const note = dmOk
            ? `🔒 Ticket closed by owner <@${interaction.user.id}>. DM transcript ✅`
            : `🔒 Ticket closed by owner <@${interaction.user.id}>. DM transcript ❌ (DMs closed). Saved here ✅`;
          await logCh.send({ content: note, files: [attachment] }).catch(() => {});
        }

        setTimeout(() => channel.delete().catch(() => {}), 5000);
        return;
      }

      return interaction.editReply({ content: "Unknown button.", components: [] });
    }

    // Modals (ONLY owners)
    if (interaction.isModalSubmit() && interaction.customId === "ticket_adduser_modal") {
      if (!ensureBotOwner(interaction)) return;

      await interaction.deferReply({ ephemeral: true });

      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ content: "Not a ticket channel." });
      }

      const raw = interaction.fields.getTextInputValue("user");
      const id = raw.replace(/[<@!>]/g, "").trim();

      let member = null;
      try {
        member = await interaction.guild.members.fetch(id);
      } catch {}

      if (!member) {
        return interaction.editReply({ content: "❌ Could not find that user ID." });
      }

      await channel.permissionOverwrites.edit(member.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });

      return interaction.editReply({ content: `✅ Added <@${member.id}> to this ticket.` });
    }

    if (interaction.isModalSubmit() && interaction.customId === "ticket_rename_modal") {
      if (!ensureBotOwner(interaction)) return;

      await interaction.deferReply({ ephemeral: true });

      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ content: "Not a ticket channel." });
      }

      const name = interaction.fields
        .getTextInputValue("name")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 90);

      if (!name || name.length < 2) {
        return interaction.editReply({ content: "❌ Invalid name." });
      }

      await channel.setName(name).catch(() => {});
      return interaction.editReply({ content: `✅ Renamed ticket to **#${name}**` });
    }
  } catch (e) {
    console.error("❌ Runtime error:", e);
    // jei dar neatsakyta - bandom atsakyti
    if (interaction?.isRepliable?.()) {
      interaction.reply({ content: "❌ Error (check Render logs).", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch((e) => console.error("❌ Login error:", e?.message || e));
