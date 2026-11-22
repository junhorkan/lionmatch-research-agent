// The agent's hands: one paid call at a time against the Flashpoint MCP.
//
// Everything here is deliberately dumb. It signs in, calls a tool, pays for
// it, writes down what happened, and refuses to spend past a cap. All the
// deciding happens in brain.mjs and agent.mjs.
//
// Payment is x402. The wallet signs an EIP-3009 authorisation — a message,
// not a transaction — and Flashpoint's facilitator submits it and pays the
// gas. That is why this wallet holds only USDC and has never needed ETH.

import fs from "node:fs";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { base } from "viem/chains";
import { Agent, setGlobalDispatcher } from "undici";

const BASE = process.env.FLASHPOINT_MCP_BASE ?? "https://api.flashpoint.ai";
const PROTOCOL_VERSION = "2025-06-18";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// A survey agent turn can think for minutes, and a panel run for far longer.
// Node's default header timeout kills both, so there is no timeout at all.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

/** What each tool costs, so the budget guard can refuse before we spend. */
export const PRICES = {
  chat: 0.01,
  demographics: 0.05,
  panel: 0.5,
  tool_survey: 0.5,
  tool_qual: 0.5,
  presentation: 0.25,
  payment_confirmation: 0,
};

export class BudgetExhausted extends Error {}
export class FlashpointError extends Error {}

function loadKey() {
  if (process.env.FLASHPOINT_WALLET_KEY) return process.env.FLASHPOINT_WALLET_KEY;
  const env = new URL("../.env", import.meta.url);
  if (!fs.existsSync(env)) return null;
  const m = fs.readFileSync(env, "utf8").match(/^FLASHPOINT_WALLET_KEY=(0x[0-9a-fA-F]{64})$/m);
  return m ? m[1] : null;
}

export function wallet() {
  const key = loadKey();
  if (!key) throw new FlashpointError("No FLASHPOINT_WALLET_KEY. Copy .env.example to .env and fill it in.");
  return privateKeyToAccount(key);
}

export async function balance() {
  const client = createPublicClient({ chain: base, transport: http() });
  const raw = await client.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet().address],
  });
  return Number(formatUnits(raw, 6));
}

const post = (url, body, headers = {}, f = fetch, signal = undefined) =>
  f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

/*
  The global dispatcher has no timeout, because a panel run legitimately takes
  half an hour. But a call that never answers would then hang forever — and on
  a live demo, a frozen terminal is the worst possible outcome. So each tool
  gets its own ceiling, generous enough for real work and short enough that a
  dead call is noticed. A chat turn that normally takes 3 seconds and has gone
  quiet for two minutes is not thinking; it is gone.
*/
const TIMEOUT_MS = {
  chat: 120_000,
  tool_survey: 300_000,
  panel: 300_000,
  default: 300_000,
};

// A FlashpointError, so the agent's run loop stops gracefully on it and still
// writes up what it learned, rather than crashing.
export class FlashpointTimeout extends FlashpointError {}

/**
 * Email addresses belong to other people. They never reach a log file, the
 * write-up, or the screen. Exported so run.mjs can apply it to everything on
 * its way out; idempotent, since a masked address has no "@" left to match.
 */
export function redact(args) {
  const scrub = (v) =>
    typeof v === "string"
      ? v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, (hit) => `<address at ${hit.split("@")[1]}>`)
      : v;
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") {
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
    }
    return scrub(o);
  };
  return walk(args);
}

/**
 * One signed-in MCP session plus a spending cap. The session lasts an hour,
 * so a long run reconnects itself.
 */
export class Flashpoint {
  constructor({ budget, log }) {
    this.budgetUsd = budget;
    this.spentUsd = 0;
    this.calls = 0;
    this.receipts = [];
    this.log = log;
    this.session = null;
    this.connectedAt = 0;
  }

  get remainingUsd() {
    return Math.max(0, this.budgetUsd - this.spentUsd);
  }

  async connect() {
    if (this.session && Date.now() - this.connectedAt < 45 * 60 * 1000) return this.session;

    const account = wallet();
    const challenge = await (await post(`${BASE}/auth/wallet/challenge`)).json();
    const signature = await account.signMessage({ message: challenge.message_to_sign });
    const res = await post(`${BASE}/auth/wallet/token`, {
      address: account.address,
      nonce: challenge.nonce,
      signature,
    });
    if (res.status !== 200) throw new FlashpointError(`sign-in failed: HTTP ${res.status}`);
    const { token } = await res.json();

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    const init = await post(
      `${BASE}/mcp`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "flashpoint-agent", version: "1" },
        },
      },
      headers,
    );
    await init.text();
    const id = init.headers.get("mcp-session-id");
    if (id) headers["Mcp-Session-Id"] = id;
    await (await post(`${BASE}/mcp`, { jsonrpc: "2.0", method: "notifications/initialized" }, headers)).text();

    this.session = {
      headers,
      paidFetch: wrapFetchWithPaymentFromConfig(fetch, {
        schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
      }),
    };
    this.connectedAt = Date.now();
    return this.session;
  }

  /**
   * Call one tool and pay for it. `why` is the agent's own reason for making
   * this call; it goes in the log so a reader can follow the reasoning.
   */
  async call(name, args = {}, why = "") {
    const limit = TIMEOUT_MS[name] ?? TIMEOUT_MS.default;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.#attempt(name, args, attempt === 1 ? why : `${why} — retry after timeout`, limit);
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        if (!timedOut) throw error;
        await this.log?.({ type: "timeout", tool: name, attempt, afterSeconds: limit / 1000 });
        if (attempt === 2) {
          throw new FlashpointTimeout(`${name} did not answer within ${limit / 1000}s on two tries.`);
        }
        // A session can die without saying so. Retry on a fresh one.
        this.session = null;
      }
    }
  }

  async #attempt(name, args, why, limit) {
    const price = PRICES[name] ?? 0.5;
    if (this.spentUsd + price > this.budgetUsd + 1e-9) {
      throw new BudgetExhausted(
        `${name} costs $${price.toFixed(2)} and only $${this.remainingUsd.toFixed(2)} of the $${this.budgetUsd.toFixed(2)} budget is left.`,
      );
    }

    const { headers, paidFetch } = await this.connect();
    const started = Date.now();
    await this.log?.({ type: "call", tool: name, why, price, args: redact(args) });

    // One signal covers the whole exchange, body included: a reply that
    // starts and then stalls is as dead as one that never starts.
    const signal = AbortSignal.timeout(limit);
    const res = await post(
      `${BASE}/mcp`,
      { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } },
      headers,
      paidFetch,
      signal,
    );

    // A receipt means the money has already left, whatever the call does next.
    // Charge ourselves here, or a paid call that then errors would spend real
    // USDC without moving the budget — and the run would overspend its cap.
    let receipt = null;
    let charged = false;
    const header = res.headers.get("payment-response");
    if (header) {
      this.spentUsd += price;
      charged = true;
      try {
        const { transaction, network } = JSON.parse(Buffer.from(header, "base64").toString());
        const scan = network === "eip155:84532" ? "https://sepolia.basescan.org" : "https://basescan.org";
        receipt = `${scan}/tx/${transaction}`;
        this.receipts.push({ tool: name, price, url: receipt, at: new Date().toISOString() });
      } catch {
        // An unreadable receipt still cost us; we just cannot link to it.
        this.receipts.push({ tool: name, price, url: null, at: new Date().toISOString() });
      }
    }

    const text = await res.text();
    if (res.status === 402) throw new FlashpointError(`payment refused for ${name}: ${text.slice(0, 300)}`);
    if (!res.ok) throw new FlashpointError(`${name} returned HTTP ${res.status}: ${text.slice(0, 300)}`);

    const line = text.split("\n").filter((l) => l.startsWith("data:")).pop();
    const message = JSON.parse(line ? line.slice(5) : text);
    if (message.error) {
      throw new FlashpointError(`${name}: ${message.error.message ?? JSON.stringify(message.error)}`);
    }

    // Some tools charge without returning a readable receipt header.
    if (!charged) this.spentUsd += price;
    this.calls += 1;

    const payload = message.result?.content?.[0]?.text;
    let result = message.result;
    if (payload !== undefined) {
      try {
        result = JSON.parse(payload);
      } catch {
        result = payload;
      }
    }

    // The surveys agent echoes panel membership back at us, so a raw result
    // would put other people's email addresses into a log file that ships
    // with the submission. Redact on the way out, not just on the way in.
    await this.log?.({
      type: "result",
      tool: name,
      price,
      receipt,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      spentUsd: Number(this.spentUsd.toFixed(2)),
      result: redact(result),
    });
    return result;
  }
}
