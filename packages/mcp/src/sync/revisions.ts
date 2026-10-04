import { z } from "zod";
import { syncRevisionsSchema } from "@aif/shared";

// MCP SDK still consumes Zod 3; validate the same wire contract at its boundary.
export const mcpSyncRevisionsSchema = z
  .record(
    z
      .array(
        z
          .object({
            streamKey: z.string(),
            sequence: z.number().int().positive(),
          })
          .strict(),
      )
      .max(100),
  )
  .refine((value) => syncRevisionsSchema.safeParse(value).success);
