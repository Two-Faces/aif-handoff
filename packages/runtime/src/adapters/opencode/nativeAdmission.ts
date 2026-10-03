import { assertNativeProcessMode } from "../../supervision/nativeProcessScope.js";
import { RuntimeExecutionError } from "../../errors.js";
import type { RuntimeRunInput } from "../../types.js";

/** HTTP cancellation cannot stop the independently owned OpenCode executor. */
export function assertOpenCodeNativeAdmission(input: RuntimeRunInput) {
  assertNativeProcessMode(input, true);
  if (input.execution?.nativeProcessScope)
    throw new RuntimeExecutionError(
      "OpenCode requires a server owned by the native supervisor",
      undefined,
      "transport",
      { adapterCode: "native_external_executor_unowned" },
    );
}
