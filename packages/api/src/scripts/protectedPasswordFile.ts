import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const MAX_PASSWORD_FILE_BYTES = 65_536;
const failureMessages = {
  password_file_not_regular: "Password path must be a regular file",
  password_file_permissions: "Password file must not be accessible by group or other users",
  password_file_too_large: "Password file must not exceed 64 KiB",
  password_file_unreadable: "Could not verify and read the protected password file",
} as const;

export class ProtectedPasswordFileError extends Error {
  constructor(readonly code: keyof typeof failureMessages) {
    super(failureMessages[code]);
  }
}

// Windows chmod does not implement owner/group permissions. Inspect the ACL and read
// through the same open handle, holding off writers/deletion until it is closed.
// FileStream.GetAccessControl: https://learn.microsoft.com/dotnet/api/system.io.filestream.getaccesscontrol
const windowsReader = `
$ErrorActionPreference = 'Stop'
$bootstrapStream = $null
$bootstrapBytes = $null
try {
  $bootstrapStream = [System.IO.File]::Open($env:AIF_BOOTSTRAP_PASSWORD_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $bootstrapAcl = $bootstrapStream.GetAccessControl()
  $bootstrapDescriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($bootstrapAcl.GetSecurityDescriptorBinaryForm(), 0)
  $bootstrapSidType = [System.Security.Principal.SecurityIdentifier]
  $bootstrapUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $bootstrapTrusted = @($bootstrapUserSid, 'S-1-5-18', 'S-1-5-32-544')
  $bootstrapOwner = $bootstrapAcl.GetOwner($bootstrapSidType).Value
  $bootstrapAllowed = $bootstrapTrusted -contains $bootstrapOwner
  if ($null -eq $bootstrapDescriptor.DiscretionaryAcl) { $bootstrapAllowed = $false }
  foreach ($bootstrapRule in $bootstrapAcl.GetAccessRules($true, $true, $bootstrapSidType)) {
    if ($bootstrapRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $bootstrapTrusted -notcontains $bootstrapRule.IdentityReference.Value) {
      $bootstrapAllowed = $false
    }
  }
  if (-not $bootstrapAllowed) {
    @{ ok = $false
       code = 'password_file_permissions' } | ConvertTo-Json -Compress
  } elseif ($bootstrapStream.Length -gt ${MAX_PASSWORD_FILE_BYTES}) {
    @{ ok = $false
       code = 'password_file_too_large' } | ConvertTo-Json -Compress
  } else {
    $bootstrapBytes = [System.IO.MemoryStream]::new()
    $bootstrapStream.CopyTo($bootstrapBytes)
    @{ ok = $true
       base64 = [System.Convert]::ToBase64String($bootstrapBytes.ToArray()) } | ConvertTo-Json -Compress
  }
} catch {
  @{ ok = $false
     code = 'password_file_unreadable' } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $bootstrapBytes) { $bootstrapBytes.Dispose() }
  if ($null -ne $bootstrapStream) { $bootstrapStream.Dispose() }
}
`;
const windowsResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      base64: z
        .string()
        .max(90_000)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(Object.keys(failureMessages) as Array<keyof typeof failureMessages>),
    })
    .strict(),
]);

function readWindowsPasswordFile(path: string): string {
  const result = spawnSync(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsReader, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, AIF_BOOTSTRAP_PASSWORD_PATH: resolve(path) },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 100_000,
    },
  );
  // Never attach subprocess output/error objects: stdout can contain the password.
  if (result.error || result.status !== 0)
    throw new ProtectedPasswordFileError("password_file_unreadable");
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new ProtectedPasswordFileError("password_file_unreadable");
  }
  const parsed = windowsResultSchema.safeParse(raw);
  if (!parsed.success) throw new ProtectedPasswordFileError("password_file_unreadable");
  if (!parsed.data.ok) throw new ProtectedPasswordFileError(parsed.data.code);
  return Buffer.from(parsed.data.base64, "base64").toString("utf8");
}

export function readProtectedPasswordFile(path: string): string {
  if (!lstatSync(path).isFile()) throw new ProtectedPasswordFileError("password_file_not_regular");
  if (process.platform === "win32") return readWindowsPasswordFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) throw new ProtectedPasswordFileError("password_file_not_regular");
    if ((metadata.mode & 0o077) !== 0)
      throw new ProtectedPasswordFileError("password_file_permissions");
    if (metadata.size > MAX_PASSWORD_FILE_BYTES)
      throw new ProtectedPasswordFileError("password_file_too_large");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
