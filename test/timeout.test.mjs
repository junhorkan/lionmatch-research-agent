// Two ways a call can die: never answering, and answering then stalling.
import http from "node:http";
import { Agent, setGlobalDispatcher } from "undici";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

// Same as the agent: no global timeout at all.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const server = http.createServer((req, res) => {
  if (req.url === "/silent") return; // never sends a byte
  if (req.url === "/stall") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("data: partial");    // headers + a bit of body, then nothing
    return;
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// The real payment wrapper, with a throwaway key that holds nothing.
const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }],
});

async function probe(path) {
  const t = Date.now();
  try {
    const res = await paidFetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", body: "{}", signal: AbortSignal.timeout(1500),
    });
    await res.text();
    return `returned (BAD) after ${Date.now() - t}ms`;
  } catch (e) {
    return `aborted as ${e.name} after ${Date.now() - t}ms`;
  }
}

const silent = await probe("/silent");
const stall = await probe("/stall");
console.log("server never answers:      ", silent);
console.log("server answers then stalls:", stall);
server.closeAllConnections?.();
server.close();

// Both must abort, and promptly: a pass that silently returned would make CI
// green while a dead call could still freeze a live run.
const pass = [silent, stall].every((r) => /^aborted as TimeoutError/.test(r));
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
