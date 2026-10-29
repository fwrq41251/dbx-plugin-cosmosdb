// The pinned Rust CLI canonicalizes Windows paths to verbatim (\\?\) form.
// Node child processes resolving relative entrypoints from that cwd can fail
// with EISDIR on the drive root. Keep the same paths using normal Win32 syntax.
export function normalizeDevPaths(config, platform = process.platform) {
  if (platform !== "win32") return config;
  const path = (value) => {
    if (typeof value !== "string") return value;
    if (value.startsWith("\\\\?\\UNC\\")) return "\\\\" + value.slice(8);
    return value.startsWith("\\\\?\\") ? value.slice(4) : value;
  };
  const command = (value) => {
    if (!value) return value;
    if (Array.isArray(value)) return value.map(path);
    return {
      ...value,
      command: path(value.command),
      cwd: path(value.cwd),
      args: value.args?.map(path),
      goWorkspace: value.goWorkspace?.map(path),
    };
  };
  return {
    ...config,
    project: path(config.project),
    dataDir: path(config.dataDir),
    backend: path(config.backend),
    backendWatch: path(config.backendWatch),
    commands: Object.fromEntries(Object.entries(config.commands || {}).map(([key, value]) => [key, command(value)])),
  };
}
