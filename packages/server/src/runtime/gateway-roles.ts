import type { GatewayClient } from "../gateway";
import type { GatewayRoles } from "../plane/gateway";

/** Adapt a GatewayClient to the three-role seam the workers consume. */
export function rolesFrom(
  gw: Pick<GatewayClient, "extract" | "synthesize" | "judge">,
): GatewayRoles {
  return {
    extract: (r) => gw.extract(r).then((x) => ({ text: x.text, model: x.model })),
    synthesize: (r) => gw.synthesize(r).then((x) => ({ text: x.text, model: x.model })),
    judge: (r) => gw.judge(r).then((x) => ({ text: x.text, model: x.model })),
  };
}
