import { assertNativeProcessMode } from "../../supervision/nativeProcessScope.js";
import { RuntimeExecutionError } from "../../errors.js";
import type { RuntimeRunInput } from "../../types.js";
import { assertNativeOpenCodeInput } from "./native.js";

/** HTTP cancellation cannot stop the independently owned OpenCode executor. */
export function assertOpenCodeNativeAdmission(input: RuntimeRunInput, ownsServer = false) {
  assertNativeProcessMode(input, true);
  const externalServer = ["baseUrl", "serverUsername", "serverPassword"].some(
    (key) => input.options?.[key] !== undefined,
  );
  if (input.execution?.nativeProcessScope && (!ownsServer || externalServer))
    throw new RuntimeExecutionError(
      "OpenCode requires a server owned by the native supervisor",
      undefined,
      "transport",
      { adapterCode: "native_external_executor_unowned" },
    );
  if (input.execution?.nativeProcessScope) assertNativeOpenCodeInput(input);
}
