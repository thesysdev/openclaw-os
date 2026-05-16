import type { Settings } from "../storage";
import type { DeviceIdentity } from "./device-identity";
import { signMessage, toBase64Url } from "./device-identity";
import type { ConnectParams } from "./types";
import { GATEWAY_CLIENT_CAPS, GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./types";

const PROTOCOL_VERSION = 4;
const CLIENT_ID = GATEWAY_CLIENT_IDS.CONTROL_UI;
const CLIENT_MODE = GATEWAY_CLIENT_MODES.UI;
const CLIENT_VERSION = "0.1.0";
const ROLE = "operator";
const SCOPES = ["operator.read", "operator.write", "operator.admin"];

/**
 * Builds the v3 signature payload string.
 * Format: v3|deviceId|clientId|clientMode|role|scopesCsv|signedAtMs|token|nonce|platformNorm|deviceFamilyNorm
 */
function buildV3Payload(
  deviceId: string,
  clientMode: string,
  signedAtMs: number,
  token: string,
  nonce: string,
): string {
  const scopesCsv = SCOPES.join(",");
  const platformNorm = "web";
  const deviceFamilyNorm = "";
  return [
    "v3",
    deviceId,
    CLIENT_ID,
    clientMode,
    ROLE,
    scopesCsv,
    signedAtMs.toString(),
    token,
    nonce,
    platformNorm,
    deviceFamilyNorm,
  ].join("|");
}

export async function buildConnectParams(
  nonce: string,
  settings: Settings,
  device: DeviceIdentity,
): Promise<ConnectParams> {
  const signedAtMs = Date.now();
  const token = settings.deviceToken ?? settings.token ?? "";
  const payload = buildV3Payload(device.deviceId, CLIENT_MODE, signedAtMs, token, nonce);
  const signatureBytes = await signMessage(payload, device.privateKey);

  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS, GATEWAY_CLIENT_CAPS.THINKING_EVENTS],
    client: {
      id: CLIENT_ID,
      version: CLIENT_VERSION,
      platform: "web",
      mode: CLIENT_MODE,
    },
    role: ROLE,
    scopes: SCOPES,
    auth: settings.deviceToken ? { deviceToken: settings.deviceToken } : { token: settings.token },
    device: {
      id: device.deviceId,
      publicKey: toBase64Url(device.publicKey),
      signature: toBase64Url(signatureBytes),
      signedAt: signedAtMs,
      nonce,
    },
    locale: "en-US",
    userAgent: `claw/${CLIENT_VERSION}`,
  };
}
