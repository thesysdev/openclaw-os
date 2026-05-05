#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";

const PLUGIN_DIR = join(homedir(), ".openclaw", "openui", "claw-plugin");
const PLUGIN_REPO = "thesysdev/openclaw-os/packages/claw-plugin";

const PREFIX = "[openclaw-os]";
const DEFAULT_API_BASE = "https://app.generativeui.cloud";
const DEFAULT_DOMAIN = "generativeui.cloud";
const DEFAULT_PORT = 18789;

function log(msg) {
  console.log(`${PREFIX} ${msg}`);
}

function fatal(msg) {
  console.error(`${PREFIX} ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs() {
  const args = {
    command: "install",
    apiBase: DEFAULT_API_BASE,
    apiBaseProvided: false,
    tunnelToken: null,
    tunnelId: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === "uninstall") {
      args.command = "uninstall";
    } else if (arg.startsWith("--api-base=")) {
      args.apiBase = arg.slice("--api-base=".length);
      args.apiBaseProvided = true;
    } else if (arg.startsWith("--tunnel-token=")) {
      args.tunnelToken = arg.slice("--tunnel-token=".length);
    } else if (arg.startsWith("--tunnel-id=")) {
      args.tunnelId = arg.slice("--tunnel-id=".length);
    } else {
      fatal(`Unknown argument: ${arg}`);
    }
  }

  if (args.command === "install") {
    const hasToken = args.tunnelToken !== null;
    const hasId = args.tunnelId !== null;
    if (hasToken !== hasId) {
      fatal(
        "--tunnel-token and --tunnel-id must be provided together or not at all.",
      );
    }
  }

  return args;
}

function readOpenClawConfig() {
  log("==> Reading OpenClaw config...");

  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) {
    fatal("OpenClaw config not found. Is OpenClaw installed?");
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const port = config.gateway?.bind?.port || DEFAULT_PORT;
  const token = config.gateway?.auth?.token;

  if (!token) {
    fatal("Gateway auth token not set. Run: openclaw auth token");
  }

  log(`    Port: ${port}`);
  return { port, token };
}

async function provision(apiBase, port) {
  log("==> Provisioning tunnel...");

  const url = `${apiBase}/api/provision`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
  } catch (err) {
    fatal(
      `Could not reach ${url} — ${err.cause?.code || err.message}. ` +
        "Check your network/firewall and that the API is running.",
    );
  }

  let body;
  try {
    body = await res.json();
  } catch {
    const text = await res.text().catch(() => "<unreadable>");
    fatal(
      `Provisioning API returned non-JSON (HTTP ${res.status}). Body: ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    fatal(
      `Provisioning failed (HTTP ${res.status}): ${body.error || res.statusText}`,
    );
  }

  log(`    Tunnel ID: ${body.tunnelId}`);
  return {
    tunnelId: body.tunnelId,
    tunnelToken: body.tunnelToken,
    gatewayUrl: body.gatewayUrl,
  };
}

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function installCloudflared() {
  log("==> Installing cloudflared...");

  if (commandExists("cloudflared")) {
    log("    Already installed, skipping.");
    return;
  }

  const platform = process.platform;

  if (platform === "darwin") {
    if (!commandExists("brew")) {
      fatal(
        "Homebrew is required to install cloudflared on macOS.\n" +
          "           Install it from https://brew.sh then re-run this script.",
      );
    }
    log("    Installing via Homebrew...");
    execSync("brew install cloudflared", { stdio: "inherit" });
  } else if (platform === "linux") {
    log("    Downloading cloudflared binary...");
    const url =
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
    execSync(
      `curl -fsSL "${url}" -o /tmp/cloudflared && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared`,
      { stdio: "inherit" },
    );
  } else {
    fatal(
      `Unsupported platform: ${platform}. Only macOS and Linux are supported.`,
    );
  }

  if (!commandExists("cloudflared")) {
    fatal("cloudflared installation failed — command not found after install.");
  }

  log("    cloudflared installed successfully.");
}

function installCloudflaredService(tunnelToken) {
  log("==> Installing cloudflared service...");
  if (isCloudflaredServiceInstalled()) {
    log("    Service already installed, skipping.");
    return;
  }

  if (!tunnelToken) {
    fatal(
      "Tunnel token is required to install the cloudflared service. " +
        "Provide --tunnel-token/--tunnel-id or run uninstall first.",
    );
  }

  execSync(`sudo cloudflared service install "${tunnelToken}"`, {
    stdio: "inherit",
  });
  log("    Service installed.");
}

function downloadPlugin() {
  log("==> Downloading OpenClaw OS plugin...");
  log(`    From: ${PLUGIN_REPO}`);

  mkdirSync(join(homedir(), ".openclaw", "openui"), { recursive: true });

  if (existsSync(PLUGIN_DIR)) {
    log("    Removing previous plugin source...");
    execSync(`rm -rf "${PLUGIN_DIR}"`, { stdio: "inherit" });
  }

  try {
    execSync(`npx -y degit ${PLUGIN_REPO} "${PLUGIN_DIR}"`, {
      stdio: "inherit",
    });
  } catch {
    fatal(
      `Failed to download plugin from ${PLUGIN_REPO}. Check your network connection and that npx is available.`,
    );
  }

  const pluginManifest = join(PLUGIN_DIR, "openclaw.plugin.json");
  if (!existsSync(pluginManifest)) {
    fatal(
      `Plugin download produced an invalid directory at ${PLUGIN_DIR} (missing openclaw.plugin.json). ` +
        `Repository path may be wrong or inaccessible: ${PLUGIN_REPO}`,
    );
  }

  log(`    Downloaded to ${PLUGIN_DIR}`);
}

function installPlugin() {
  log("==> Installing OpenClaw OS plugin...");
  if (isPluginRegistered()) {
    log("    Plugin already registered, reinstalling to pick up updates...");
    try {
      execSync("openclaw plugins uninstall openclaw-os-plugin", {
        stdio: "inherit",
      });
      log("    Existing plugin unregistered.");
    } catch {
      log("    WARNING: Could not unregister existing plugin; continuing.");
    }
  }

  execSync(`openclaw plugins install -l "${PLUGIN_DIR}"`, {
    stdio: "inherit",
  });
  log("    Plugin installed.");
}

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
const CLOUD_FLARED_SERVICE_FILES = [
  "/Library/LaunchDaemons/com.cloudflare.cloudflared.plist",
  "/etc/systemd/system/cloudflared.service",
];

function isCloudflaredServiceInstalled() {
  return CLOUD_FLARED_SERVICE_FILES.some((path) => existsSync(path));
}

function isPluginRegistered() {
  try {
    const output = execSync("openclaw plugins list", { encoding: "utf8" });
    return output.includes("openclaw-os-plugin");
  } catch {
    return false;
  }
}

// TODO: openclaw onboard sets tools.profile="coding" by default, which blocks all plugin tools
// via applyToolPolicyPipeline unless tools.alsoAllow includes "group:plugins" or the plugin id.
// Ideally openclaw's onboarding wizard (or `openclaw plugins install`) should detect a restrictive
// profile and prompt the user to add alsoAllow, similar to how addAllowedOrigin works here.
// Tracked: remove this workaround once openclaw handles it natively.
function ensurePluginToolsAllowed() {
  log("==> Ensuring plugin tools are accessible...");

  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    log("    WARNING: OpenClaw config not found, skipping.");
    return;
  }

  const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf8"));
  const profile = config.tools?.profile;
  const alsoAllow = config.tools?.alsoAllow ?? [];

  // Only needed when a restrictive profile is active (coding / minimal).
  // "full" and no-profile configs already allow all tools.
  if (!profile || profile === "full") {
    log("    No restrictive profile set, skipping.");
    return;
  }

  if (alsoAllow.includes("group:plugins")) {
    log(`    tools.alsoAllow already includes "group:plugins", skipping.`);
    return;
  }

  if (!config.tools) config.tools = {};
  config.tools.alsoAllow = [...alsoAllow, "group:plugins"];

  writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 4) + "\n");
  log(`    Added "group:plugins" to tools.alsoAllow (profile=${profile})`);
}

function restartGateway() {
  log("==> Restarting OpenClaw gateway...");
  try {
    execSync("openclaw gateway restart", { stdio: "inherit" });
    log("    Gateway restarted.");
  } catch {
    log(
      "    WARNING: Could not restart gateway automatically. Please run: openclaw restart",
    );
  }
}

function addAllowedOrigin(apiBase) {
  log("==> Configuring gateway allowed origins...");

  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    log("    WARNING: OpenClaw config not found, skipping.");
    return;
  }

  const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf8"));
  const origin = new URL(apiBase).origin;

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.controlUi) config.gateway.controlUi = {};

  const origins = Array.isArray(config.gateway.controlUi.allowedOrigins)
    ? config.gateway.controlUi.allowedOrigins
    : [];

  if (origins.includes(origin)) {
    log(`    ${origin} already allowed, skipping.`);
    return;
  }

  origins.push(origin);
  config.gateway.controlUi.allowedOrigins = origins;

  writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 4) + "\n");
  log(`    Added ${origin} to gateway.controlUi.allowedOrigins`);
}

function removeAllowedOrigin(apiBase) {
  log("==> Removing gateway allowed origin...");

  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    log("    WARNING: OpenClaw config not found, skipping.");
    return;
  }

  const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf8"));
  const origin = new URL(apiBase).origin;
  const origins = config.gateway?.controlUi?.allowedOrigins;

  if (!Array.isArray(origins) || !origins.includes(origin)) {
    log(`    ${origin} not in allowedOrigins, skipping.`);
    return;
  }

  config.gateway.controlUi.allowedOrigins = origins.filter((o) => o !== origin);

  writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 4) + "\n");
  log(`    Removed ${origin} from gateway.controlUi.allowedOrigins`);
}

function saveConfig({ tunnelId, gatewayUrl, apiBase, tunnelToken }) {
  log("==> Saving config...");

  const dir = join(homedir(), ".openclaw", "openui");
  mkdirSync(dir, { recursive: true });

  const configPath = join(dir, "config.json");
  const config = {
    tunnelId,
    gatewayUrl,
    apiBase,
    tunnelToken: tunnelToken || null,
    createdAt: new Date().toISOString(),
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  log(`    Saved to ${configPath}`);
}

const CONFIG_PATH = join(homedir(), ".openclaw", "openui", "config.json");

function readSavedConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

async function deprovision(apiBase, tunnelId) {
  log("==> Removing tunnel and DNS...");
  if (!tunnelId) {
    log("    No tunnel ID found, skipping deprovision.");
    return;
  }

  let res;
  try {
    res = await fetch(`${apiBase}/api/provision`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tunnelId }),
    });
  } catch (err) {
    log(
      `    WARNING: Could not reach deprovision API — ${err.cause?.code || err.message}`,
    );
    return;
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    // Keep uninstall idempotent even if API returns non-JSON.
  }

  if (!res.ok) {
    log(`    WARNING: Deprovision failed: ${body.error || res.statusText}`);
  } else {
    log("    Tunnel and DNS removed.");
  }
}

function uninstallCloudflaredService() {
  log("==> Uninstalling cloudflared service...");

  try {
    execSync("sudo cloudflared service uninstall", { stdio: "inherit" });
    log("    Service uninstalled.");
  } catch {
    log("    WARNING: Service uninstall failed (may not have been installed).");
  }
}

function removePlugin() {
  log("==> Removing OpenClaw OS plugin...");

  try {
    execSync("openclaw plugins uninstall openclaw-os-plugin", { stdio: "inherit" });
    log("    Plugin unregistered.");
  } catch {
    log("    WARNING: Plugin unregister failed (may not have been installed).");
  }

  if (existsSync(PLUGIN_DIR)) {
    execSync(`rm -rf "${PLUGIN_DIR}"`, { stdio: "inherit" });
    log(`    Removed ${PLUGIN_DIR}`);
  }
}

function removeSavedConfig() {
  log("==> Removing saved config...");

  if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH);
    log(`    Removed ${CONFIG_PATH}`);
  } else {
    log("    No config file to remove.");
  }
}

async function install(args) {
  if (!commandExists("openclaw")) {
    fatal(
      "OpenClaw CLI not found. Install it first: https://openclaw.com/docs/install",
    );
  }

  const { port, token } = readOpenClawConfig();
  const saved = readSavedConfig();
  const apiBase =
    !args.apiBaseProvided && saved?.apiBase ? saved.apiBase : args.apiBase;

  let tunnelId, tunnelToken, gatewayUrl;

  if (args.tunnelToken && args.tunnelId) {
    log("==> Using provided tunnel credentials (skipping provisioning)...");
    tunnelId = args.tunnelId;
    tunnelToken = args.tunnelToken;
    gatewayUrl = `wss://${tunnelId}-gw.${DEFAULT_DOMAIN}`;
    log(`    Tunnel ID: ${tunnelId}`);
  } else if (saved?.tunnelId) {
    log("==> Reusing saved tunnel config (skipping provisioning)...");
    tunnelId = saved.tunnelId;
    tunnelToken = saved.tunnelToken || null;
    gatewayUrl = saved.gatewayUrl || `wss://${tunnelId}-gw.${DEFAULT_DOMAIN}`;
    log(`    Tunnel ID: ${tunnelId}`);
  } else {
    ({ tunnelId, tunnelToken, gatewayUrl } = await provision(apiBase, port));
  }

  addAllowedOrigin(apiBase);
  downloadPlugin();
  installPlugin();
  ensurePluginToolsAllowed();
  restartGateway();
  installCloudflared();
  installCloudflaredService(
    args.tunnelToken ||
      (saved?.tunnelId === tunnelId ? saved.tunnelToken : null) ||
      tunnelToken,
  );
  saveConfig({
    tunnelId,
    gatewayUrl,
    apiBase,
    tunnelToken:
      args.tunnelToken ||
      (saved?.tunnelId === tunnelId ? saved.tunnelToken : null) ||
      tunnelToken,
  });

  const setupUrl = `${apiBase}/setup#gateway=${encodeURIComponent(gatewayUrl)}&token=${encodeURIComponent(token)}`;

  console.log();
  log("==> Setup complete! Open this link in your browser:");
  console.log();
  console.log(`    ${setupUrl}`);
  console.log();
  log(
    "    The UI will show a pairing command — run it on this machine to approve the device.",
  );
}

async function uninstall(args) {
  const saved = readSavedConfig();
  const apiBase =
    args.apiBase !== DEFAULT_API_BASE
      ? args.apiBase
      : saved?.apiBase || DEFAULT_API_BASE;
  const tunnelId = saved?.tunnelId;

  if (tunnelId) {
    log(`    Tunnel ID: ${tunnelId}`);
  } else {
    log("    No saved tunnel ID found.");
  }

  uninstallCloudflaredService();
  await deprovision(apiBase, tunnelId);
  removePlugin();
  removeAllowedOrigin(apiBase);
  restartGateway();
  removeSavedConfig();

  console.log();
  log("==> Uninstall complete.");
  console.log();
}

async function main() {
  const args = parseArgs();

  if (args.command === "uninstall") {
    await uninstall(args);
  } else {
    await install(args);
  }
}

main().catch((err) => {
  fatal(err.message);
});
