require("dotenv").config();
const { REST, Routes } = require("discord.js");

const commands = [
  { name: "ticket-setup", description: "Post the professional ticket panel" },
  { name: "ticket-diag", description: "Check bot permissions & env configuration" },
];

(async () => {
  try {
    if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing in .env");
    if (!process.env.CLIENT_ID) throw new Error("CLIENT_ID missing in .env");
    if (!process.env.GUILD_ID) throw new Error("GUILD_ID missing in .env");

    console.log("⏳ Registering slash commands...");
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );

    console.log("✅ Slash commands registered!");
  } catch (err) {
    console.error("❌ Deploy error:", err?.message || err);
    if (err?.stack) console.error(err.stack);
  }
})();
