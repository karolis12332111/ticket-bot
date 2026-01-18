require("dotenv").config();

/* ================= DEBUG ================= */
console.log("BOOT START");
console.log("DISCORD_TOKEN length:", process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.length : 0);

/* ================= WEB SERVER (Render) ================= */
const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.send("HEALTHY"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("WEB SERVER RUNNING ON PORT", PORT);
});

/* ================= DISCORD ================= */
const { Client, GatewayIntentBits } = require("discord.js");

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN MISSING");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", () => {
  console.log("✅ BOT ONLINE AS:", client.user.tag, client.user.id);
});

/* ===== TEST COMMAND ===== */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply({ content: "🏓 Pong!", ephemeral: true });
  }
});

/* ================= LOGIN ================= */
(async () => {
  try {
    console.log("LOGIN: trying...");
    await client.login(process.env.DISCORD_TOKEN);
    console.log("LOGIN: success");
  } catch (e) {
    console.error("❌ LOGIN FAILED:", e);
  }
})();
