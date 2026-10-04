import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeTransport } from "../types.js";
import {
  buildCodexAppServerDiscoveryEnvWithStats,
  resolveDiscoveryExecutable,
} from "../adapters/codex/modelDiscovery/process.js";

function createModelDiscoveryInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    options: {},
    ...overrides,
  };
}

function clearProxyEnv() {
  vi.stubEnv("HTTP_PROXY", undefined);
  vi.stubEnv("HTTPS_PROXY", undefined);
  vi.stubEnv("ALL_PROXY", undefined);
  vi.stubEnv("NO_PROXY", undefined);
  vi.stubEnv("http_proxy", undefined);
  vi.stubEnv("https_proxy", undefined);
  vi.stubEnv("all_proxy", undefined);
  vi.stubEnv("no_proxy", undefined);
}

describe("codex model discovery process helpers", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("CODEX_CLI_PATH", undefined);
    clearProxyEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds curated discovery env, blocks deprecated base-url key, and reports filtered npm_ keys", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    vi.stubEnv("OPENAI_BASE_URL", "https://deprecated.example.com/v1");
    vi.stubEnv("npm_config_registry", "https://registry.npmjs.org");
    vi.stubEnv("UNRELATED_SECRET", "do-not-forward");

    const result = buildCodexAppServerDiscoveryEnvWithStats(
      createModelDiscoveryInput({
        baseUrl: "https://runtime.example.com/v1",
        apiKeyEnvVar: "OPENAI_API_KEY",
        apiKey: "sk-input",
      }),
    );

    expect(result.env.OPENAI_API_KEY).toBe("sk-input");
    expect(result.env.CODEX_BASE_URL).toBe("https://runtime.example.com/v1");
    expect(result.env.OPENAI_BASE_URL).toBeUndefined();
    expect(result.env.npm_config_registry).toBeUndefined();
    expect(result.blockedCount).toBeGreaterThanOrEqual(1);
    expect(result.filteredCount).toBeGreaterThanOrEqual(1);
    expect(result.droppedDisallowedPrefixKeys).toContain("npm_config_registry");
  });

  it("normalizes both proxy spellings for the host OS in closed-network builds", () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.example.com:8080");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.com:8080");
    vi.stubEnv("ALL_PROXY", "socks5://proxy.example.com:1080");
    vi.stubEnv("NO_PROXY", "localhost,127.0.0.1,api,agent");
    vi.stubEnv("http_proxy", "http://proxy.example.com:8080");
    vi.stubEnv("https_proxy", "http://proxy.example.com:8080");
    vi.stubEnv("all_proxy", "socks5://proxy.example.com:1080");
    vi.stubEnv("no_proxy", "localhost,127.0.0.1,api,agent");

    const result = buildCodexAppServerDiscoveryEnvWithStats(
      createModelDiscoveryInput({
        baseUrl: "https://runtime.example.com/v1",
        apiKeyEnvVar: "OPENAI_API_KEY",
        apiKey: "sk-input",
      }),
    );

    expect(result.env.HTTP_PROXY).toBe("http://proxy.example.com:8080");
    expect(result.env.HTTPS_PROXY).toBe("http://proxy.example.com:8080");
    expect(result.env.ALL_PROXY).toBe("socks5://proxy.example.com:1080");
    expect(result.env.NO_PROXY).toBe("localhost,127.0.0.1,api,agent");
    expect(result.env.http_proxy).toBe(
      process.platform === "win32" ? undefined : "http://proxy.example.com:8080",
    );
    expect(result.env.https_proxy).toBe(
      process.platform === "win32" ? undefined : "http://proxy.example.com:8080",
    );
    expect(result.env.all_proxy).toBe(
      process.platform === "win32" ? undefined : "socks5://proxy.example.com:1080",
    );
    expect(result.env.no_proxy).toBe(
      process.platform === "win32" ? undefined : "localhost,127.0.0.1,api,agent",
    );
  });

  it("preserves uppercase proxy values with OS-appropriate aliases", () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.example.com:8080");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.com:8080");
    vi.stubEnv("ALL_PROXY", "socks5://proxy.example.com:1080");
    vi.stubEnv("NO_PROXY", "localhost,127.0.0.1,api,agent");

    const result = buildCodexAppServerDiscoveryEnvWithStats(createModelDiscoveryInput());

    expect(result.env.HTTP_PROXY).toBe("http://proxy.example.com:8080");
    expect(result.env.HTTPS_PROXY).toBe("http://proxy.example.com:8080");
    expect(result.env.ALL_PROXY).toBe("socks5://proxy.example.com:1080");
    expect(result.env.NO_PROXY).toBe("localhost,127.0.0.1,api,agent");
    expect(result.env.http_proxy).toBe(
      process.platform === "win32" ? undefined : "http://proxy.example.com:8080",
    );
    expect(result.env.https_proxy).toBe(
      process.platform === "win32" ? undefined : "http://proxy.example.com:8080",
    );
    expect(result.env.all_proxy).toBe(
      process.platform === "win32" ? undefined : "socks5://proxy.example.com:1080",
    );
    expect(result.env.no_proxy).toBe(
      process.platform === "win32" ? undefined : "localhost,127.0.0.1,api,agent",
    );
  });

  it("preserves lowercase proxy values with OS-appropriate aliases", () => {
    vi.stubEnv("http_proxy", "http://proxy.example.com:8080");
    vi.stubEnv("https_proxy", "http://proxy.example.com:8080");
    vi.stubEnv("all_proxy", "socks5://proxy.example.com:1080");
    vi.stubEnv("no_proxy", "localhost,127.0.0.1,api,agent");

    const result = buildCodexAppServerDiscoveryEnvWithStats(createModelDiscoveryInput());

    expect(result.env.http_proxy).toBe(
      process.platform === "win32" ? undefined : "http://proxy.example.com:8080",
    );
    expect(result.env.https_proxy).toBe(
      process.platform === "win32" ? undefined : "http://proxy.example.com:8080",
    );
    expect(result.env.all_proxy).toBe(
      process.platform === "win32" ? undefined : "socks5://proxy.example.com:1080",
    );
    expect(result.env.no_proxy).toBe(
      process.platform === "win32" ? undefined : "localhost,127.0.0.1,api,agent",
    );
    expect(result.env.HTTP_PROXY).toBe("http://proxy.example.com:8080");
    expect(result.env.HTTPS_PROXY).toBe("http://proxy.example.com:8080");
    expect(result.env.ALL_PROXY).toBe("socks5://proxy.example.com:1080");
    expect(result.env.NO_PROXY).toBe("localhost,127.0.0.1,api,agent");
  });

  it("resolves discovery executable from options/env/defaults", () => {
    expect(
      resolveDiscoveryExecutable(
        createModelDiscoveryInput({
          options: { codexCliPath: "/custom/codex" },
          transport: RuntimeTransport.CLI,
        }),
      ),
    ).toBe("/custom/codex");

    vi.stubEnv("CODEX_CLI_PATH", "/env/codex");
    expect(
      resolveDiscoveryExecutable(
        createModelDiscoveryInput({
          options: {},
          transport: RuntimeTransport.CLI,
        }),
      ),
    ).toBe("/env/codex");

    vi.stubEnv("CODEX_CLI_PATH", undefined);
    expect(
      resolveDiscoveryExecutable(
        createModelDiscoveryInput({
          options: {},
          transport: RuntimeTransport.CLI,
        }),
      ),
    ).toBe("codex");
  });

  it("uses installed codex on PATH for sdk transport when no explicit cli path is set", () => {
    expect(
      resolveDiscoveryExecutable(
        createModelDiscoveryInput({
          transport: RuntimeTransport.SDK,
          options: {},
        }),
      ),
    ).toBe("codex");
  });
});
