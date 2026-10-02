/** Personal projects are board-only until device grants and fencing ship. */
export class PersonalExecutionDisabledError extends Error {
  readonly code = "personal_execution_disabled";

  constructor() {
    super("Execution is disabled for personal projects until device handoff is available");
    this.name = "PersonalExecutionDisabledError";
  }
}

export const PERSONAL_EXECUTION_BLOCK = {
  code: "personal_execution_disabled",
  error: "Execution is disabled for personal projects until device handoff is available",
} as const;

export const LOCAL_PUBLICATION_BLOCK = {
  code: "local_publication_only",
  error: "This project allows local commits only; publish manually after review",
} as const;
