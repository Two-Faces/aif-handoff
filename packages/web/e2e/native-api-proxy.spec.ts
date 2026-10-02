import { expect, test } from "@playwright/test";

test("proxies personal peer administration to the real API", async ({ request }) => {
  test.skip(process.env.AIF_E2E_ISOLATED_UI === "true", "Requires the native API server");

  const status = await request.get("/peers");
  expect(status.status()).toBe(200);
  expect(status.headers()["content-type"]).toContain("application/json");
  expect(await status.json()).toMatchObject({
    enabled: expect.any(Boolean),
    peers: expect.any(Array),
    executionReady: false,
  });

  // Invalid input reaches API validation and never creates an invitation.
  const invalidInvite = await request.post("/peers/invitations", { data: {} });
  expect(invalidInvite.status()).toBe(400);
  expect(invalidInvite.headers()["content-type"]).toContain("application/json");
});
