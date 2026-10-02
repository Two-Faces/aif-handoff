import { expect, test } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000171";
const taskId = "00000000-0000-4000-8000-000000000172";
const deviceId = "00000000-0000-4000-8000-000000000173";
const stream = `${projectId}:${deviceId}:00000000-0000-4000-8000-000000000174`;
for (const theme of ["light", "dark"] as const)
  test(`personal LAN settings and conflict resolution in ${theme} theme`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let resolved = false;
    const versions = [
      { dot: { streamKey: stream, sequence: 1 }, context: {}, value: "Plan written on Windows" },
      {
        dot: {
          streamKey: stream.replace(deviceId, "00000000-0000-4000-8000-000000000175"),
          sequence: 1,
        },
        context: {},
        value: "Plan written on Mac",
      },
    ];
    const project = {
      id: projectId,
      name: "Personal LAN pilot",
      rootPath: "",
      personalMode: true,
      publicationPolicy: "local_only",
      createdAt: "2026-10-02",
      updatedAt: "2026-10-02",
      tokenInput: 0,
      tokenOutput: 0,
      tokenTotal: 0,
      costUsd: 0,
    };
    await page.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      let body: unknown;
      if (path === "/auth/session")
        body = { participantsModeEnabled: false, authenticated: true, participant: null };
      else if (path === "/projects") body = [project];
      else if (path === "/tasks") body = [];
      else if (path === "/settings")
        body = {
          usageLimitsEnabled: false,
          warmupEnabled: false,
          qaPipelineEnabled: false,
          runtimeReadiness: {},
          runtimeDefaults: { app: {} },
        };
      else if (path === "/settings/runtime-defaults") body = {};
      else if (path.includes("/effective/")) body = { profile: null, resolved: null };
      else if (
        path === "/runtime-profiles" ||
        path === "/runtimes" ||
        path === "/participants" ||
        path === `/projects/${projectId}/runtime-profiles`
      )
        body = [];
      else if (path.includes("/checkouts")) body = { checkouts: [] };
      else if (path.includes("/identities"))
        body = [{ id: taskId, displayName: "Local owner on Mac", localParticipantId: null }];
      else if (path.endsWith("/conflicts/resolve")) {
        const input = route.request().postDataJSON();
        expect(input.parents).toEqual(versions.map((version) => version.dot));
        expect(input.value).toBe("Plan written on Mac");
        resolved = true;
        body = { resolved: true };
      } else if (path.endsWith("/conflicts"))
        body = resolved ? [] : [{ entityType: "task", entityId: taskId, field: "plan", versions }];
      else if (path === "/peers")
        body = {
          enabled: true,
          port: 3010,
          device: { deviceId, name: "Windows workstation", fingerprint: "a".repeat(64) },
          peers: [
            {
              deviceId: taskId,
              name: "MacBook",
              fingerprint: "b".repeat(64),
              address: null,
              revoked: false,
              lastContactAt: null,
              lastErrorCode: "peer_unavailable",
              projects: [
                { projectId, bootstrapped: false, pendingOperations: 7, pendingCountCapped: true },
              ],
            },
          ],
          executionReady: false,
        };
      else if (path.includes("/mcp")) body = { installed: false, runtimes: [] };
      else if (path.includes("/config")) body = { exists: false };
      else return route.fallback();
      await route.fulfill({ json: body });
    });
    await page.setViewportSize({ width: 1365, height: 960 });
    await page.goto(`/project/${projectId}`);
    await page.evaluate(
      (theme) => document.documentElement.classList.toggle("light", theme === "light"),
      theme,
    );
    await page.getByRole("button", { name: "Personal project settings", exact: true }).click();
    const projectPanel = page.getByRole("region", { name: "Personal project", exact: true });
    await expect(projectPanel.getByText("Plan written on Mac", { exact: true })).toBeVisible();
    await projectPanel.screenshot({ path: testInfo.outputPath(`project-${theme}.png`) });
    await projectPanel.getByRole("button", { name: "Keep version 2", exact: true }).click();
    await expect(projectPanel.getByText("No unresolved conflicts.")).toBeVisible();
    await page.getByRole("button", { name: "Global settings", exact: true }).click();
    const devices = page.getByRole("region", { name: "Personal LAN sync", exact: true });
    await expect(devices.getByText("Board only · execution disabled")).toBeVisible();
    await devices.getByLabel("Other device fingerprint", { exact: true }).fill("b".repeat(64));
    await devices.getByRole("checkbox", { name: "Personal LAN pilot" }).check();
    await expect(
      devices.getByRole("button", { name: "Create five-minute invitation" }),
    ).toBeEnabled();
    await devices.screenshot({ path: testInfo.outputPath(`devices-${theme}.png`) });
    expect(errors).toEqual([]);
  });
