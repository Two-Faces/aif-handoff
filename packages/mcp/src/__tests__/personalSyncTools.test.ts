import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTestDb } from "@aif/shared/server";
import { z } from "zod";
import { RateLimiter } from "../middleware/rateLimit.js";

const db = { current: createTestDb() };
const callbacks = new Map<string, (input: unknown) => Promise<unknown>>();
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
vi.mock("../tools/index.js", () => ({
  registerMcpTool: (
    _server: unknown,
    name: string,
    _description: string,
    _schema: unknown,
    callback: (input: unknown) => Promise<unknown>,
  ) => callbacks.set(name, callback),
}));
vi.mock("../utils/broadcast.js", () => ({ broadcastTaskChange: vi.fn() }));
const data = await import("@aif/data");
const planTool = await import("../tools/pushPlan.js");
const statusTool = await import("../tools/syncStatus.js");
beforeEach(() => {
  db.current.$client.close();
  db.current = createTestDb();
  callbacks.clear();
  const server = new McpServer({ name: "test", version: "1" });
  const context = {
    rateLimiter: new RateLimiter({ rpm: 100, burst: 100 }, { rpm: 100, burst: 100 }),
  };
  planTool.register(server, context);
  statusTool.register(server, context);
});
const response = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
describe("MCP personal project writes", () => {
  it("requires the fetched plan revision and keeps the original plan on a stale retry", async () => {
    const project = data.createProject({ name: "Board", rootPath: "", personalMode: true })!;
    const task = data.createTask({ projectId: project.id, title: "MCP", description: "" })!;
    const expected = data.toTaskResponse(task).syncRevisions;
    const push = callbacks.get("handoff_push_plan")!;
    await expect(push({ taskId: task.id, planContent: "Missing CAS" })).rejects.toMatchObject({
      data: { code: "sync_revision_required" },
    });
    const result = response.parse(
      await push({ taskId: task.id, planContent: "Saved plan", expectedSyncRevisions: expected }),
    );
    expect(JSON.parse(result.content[0]!.text).task.syncRevisions.plan).not.toEqual(expected?.plan);
    await expect(
      push({ taskId: task.id, planContent: "Stale", expectedSyncRevisions: expected }),
    ).rejects.toMatchObject({ data: { code: "sync_revision_conflict" } });
    expect(data.findTaskById(task.id)?.plan).toBe("Saved plan");
  });
  it("uses workflow revisions instead of clocks and still rejects agent transitions on human-owned tasks", async () => {
    const project = data.createProject({ name: "Board", rootPath: "", personalMode: true })!;
    const task = data.createTask({ projectId: project.id, title: "MCP", description: "" })!;
    const expected = data.toTaskResponse(task).syncRevisions;
    const sync = callbacks.get("handoff_sync_status")!;
    const args = {
      taskId: task.id,
      newStatus: "planning",
      sourceTimestamp: "1900-01-01T00:00:00Z",
      direction: "mcp_to_handoff",
      expectedSyncRevisions: expected,
    };
    const result = response.parse(await sync(args));
    expect(JSON.parse(result.content[0]!.text).applied).toBe(true);
    expect(data.findTaskById(task.id)?.status).toBe("planning");
    await expect(sync({ ...args, newStatus: "plan_ready" })).rejects.toMatchObject({
      data: { code: "sync_revision_conflict" },
    });
    const human = data.createTask({
      projectId: project.id,
      title: "Human",
      description: "",
      executionOwner: "human",
    })!;
    const rejected = response.parse(
      await sync({
        ...args,
        taskId: human.id,
        expectedSyncRevisions: data.toTaskResponse(human).syncRevisions,
      }),
    );
    expect(JSON.parse(rejected.content[0]!.text).applied).toBe(false);
    expect(data.findTaskById(human.id)?.status).toBe("backlog");
  });
});
