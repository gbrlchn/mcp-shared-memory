import type { Config } from "./config.js";
import type { Sandbox } from "./sandbox.js";
import type { Audit } from "./audit.js";

export interface Ctx {
  config: Config;
  sandbox: Sandbox;
  audit: Audit;
}
