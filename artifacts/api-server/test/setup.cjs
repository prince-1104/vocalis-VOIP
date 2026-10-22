// Installed before application imports: loopback fixtures are the only permitted
// HTTP destinations. An accidental real Twilio/model/CRM request fails locally.
const allowed = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const validate = (input) => {
  const host =
    typeof input === "string" || input instanceof URL
      ? new URL(input).hostname
      : input?.hostname || input?.host || "localhost";
  if (!allowed.has(host))
    throw new Error("External HTTP is disabled in security tests");
};
for (const module of [require("node:http"), require("node:https")]) {
  for (const method of ["request", "get"]) {
    const original = module[method];
    module[method] = function (input, ...args) {
      validate(input);
      return original.call(this, input, ...args);
    };
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  validate(input instanceof Request ? input.url : input);
  return originalFetch(input, ...args);
};

// The imported CRM lookup module owns a cache-maintenance interval. Collect
// intervals so the root test teardown can dispose it without starting app jobs.
globalThis.__dialogTestIntervals = [];
const originalInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const timer = originalInterval(...args);
  globalThis.__dialogTestIntervals.push(timer);
  return timer;
};
