import { createSafeHttpClient } from "./safe-outbound-http";

/** The only client used for tenant-configured CRM lookup and webhook URLs. */
export const crmHttp = createSafeHttpClient();
