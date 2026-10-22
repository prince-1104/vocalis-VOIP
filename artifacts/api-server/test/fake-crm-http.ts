import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type AddressInfo } from "node:net";
import path from "node:path";
import { createSafeHttpClient, isPublicAddress, type OutboundResolver } from "../src/lib/safe-outbound-http";

// Substituted for src/lib/crm-http by the test runner. Application code keeps
// the production URL and address policy; the only differences are a fake DNS
// table, a test CA, and the single loopback address the HTTPS fixtures use.

const fixtures = path.join(process.cwd(), "test/fixtures/crm-tls");
export const crmTestCa = readFileSync(path.join(fixtures, "ca.pem"));
export const crmTestKey = readFileSync(path.join(fixtures, "crm-key.pem"));
export const crmTestCert = readFileSync(path.join(fixtures, "crm.pem"));

/** Hostnames covered by the fixture certificate. */
export const CRM_TEST_HOST = "crm.dialog.test";
export const CRM_TEST_OTHER_HOST = "other.crm.dialog.test";
export const FIXTURE_ADDRESS = "127.0.0.1";

export const crmTestDns = new Map<string, string[]>();
export const crmDnsQueries: string[] = [];
export function resetCrmTestDns(): void {
  crmTestDns.clear();
  crmDnsQueries.length = 0;
  crmTestDns.set(CRM_TEST_HOST, [FIXTURE_ADDRESS]);
  crmTestDns.set(CRM_TEST_OTHER_HOST, [FIXTURE_ADDRESS]);
}
resetCrmTestDns();

export const fakeResolve: OutboundResolver = async (hostname) => {
  crmDnsQueries.push(hostname);
  const answers = crmTestDns.get(hostname);
  if (!answers) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  return answers.map((address) => ({ address, family: isIP(address) }));
};

export const allowFixture = (address: string) => address === FIXTURE_ADDRESS || isPublicAddress(address);

/** HTTPS CRM fixture reachable as https://crm.dialog.test:<port>. */
export async function listenCrmFixture(handler: RequestListener) {
  const server = createHttpsServer({ key: crmTestKey, cert: crmTestCert }, handler).listen(0, FIXTURE_ADDRESS);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { server, port, base: `https://${CRM_TEST_HOST}:${port}` };
}

export const crmHttp = createSafeHttpClient({
  resolve: fakeResolve,
  isAllowedAddress: allowFixture,
  ca: crmTestCa,
});
