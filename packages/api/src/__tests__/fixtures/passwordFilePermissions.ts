import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";

/** Native ACL fixture: no credentials or local account names are embedded in shell text. */
export function setPasswordFilePermissions(
  path: string,
  broadAccess: "read" | "write" | null,
): void {
  if (process.platform !== "win32") {
    chmodSync(path, broadAccess === "read" ? 0o644 : broadAccess === "write" ? 0o622 : 0o600);
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
$bootstrapFixturePath = $env:AIF_PASSWORD_FIXTURE_PATH
$bootstrapFixtureDirectory = [System.IO.Directory]::Exists($bootstrapFixturePath)
$bootstrapFixtureUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($bootstrapFixtureDirectory) {
  $bootstrapFixtureAcl = [System.Security.AccessControl.DirectorySecurity]::new()
  $bootstrapFixtureInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  $bootstrapFixtureAcl = [System.Security.AccessControl.FileSecurity]::new()
  $bootstrapFixtureInheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$bootstrapFixtureAcl.SetOwner($bootstrapFixtureUser)
$bootstrapFixtureAcl.SetAccessRuleProtection($true, $false)
$bootstrapFixtureAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($bootstrapFixtureUser, [System.Security.AccessControl.FileSystemRights]::FullControl, $bootstrapFixtureInheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
if ($env:AIF_PASSWORD_FIXTURE_ACCESS -ne '') {
  $bootstrapFixtureEveryone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $bootstrapFixtureRights = if ($env:AIF_PASSWORD_FIXTURE_ACCESS -eq 'read') { [System.Security.AccessControl.FileSystemRights]::Read } else { [System.Security.AccessControl.FileSystemRights]::Write }
  $bootstrapFixtureAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($bootstrapFixtureEveryone, $bootstrapFixtureRights, $bootstrapFixtureInheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
}
if ($bootstrapFixtureDirectory) { [System.IO.Directory]::SetAccessControl($bootstrapFixturePath, $bootstrapFixtureAcl) }
else { [System.IO.File]::SetAccessControl($bootstrapFixturePath, $bootstrapFixtureAcl) }
`;
  const result = spawnSync(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...process.env,
        AIF_PASSWORD_FIXTURE_PATH: resolve(path),
        AIF_PASSWORD_FIXTURE_ACCESS: broadAccess ?? "",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Fixture ACL setup failed (${result.status})`);
}
