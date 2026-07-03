/**
 * Secret references resolve harness-side, at run construction time. Values
 * flow into tool clients and (only when exposed) sandbox environments —
 * never into session events or model context, and errors name the ref, not
 * the value.
 */

export async function resolveSecretRefs(
  refs: Record<string, string>
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [name, ref] of Object.entries(refs)) {
    resolved[name] = await resolveSecretRef(name, ref);
  }

  return resolved;
}

export async function resolveSecretRef(name: string, ref: string): Promise<string> {
  const separator = ref.indexOf("://");
  const scheme = ref.slice(0, separator);
  const rest = ref.slice(separator + 3);

  if (scheme === "env") {
    const value = process.env[rest];

    if (!value) {
      throw new Error(`Secret "${name}": environment variable ${rest} is not set.`);
    }

    return value;
  }

  if (scheme === "file") {
    try {
      const text = await Bun.file(rest.startsWith("/") ? rest : `/${rest}`).text();
      return text.trim();
    } catch {
      throw new Error(`Secret "${name}": file not readable: ${rest}`);
    }
  }

  if (scheme === "keychain") {
    const [service, account] = rest.split("/", 2);

    if (!service) {
      throw new Error(`Secret "${name}": keychain refs look like keychain://service/account`);
    }

    const args = ["find-generic-password", "-s", service, "-w"];

    if (account) {
      args.splice(3, 0, "-a", account);
    }

    const proc = Bun.spawn(["security", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Secret "${name}": keychain item not found (service "${service}"${account ? `, account "${account}"` : ""}).`
      );
    }

    return stdout.trim();
  }

  throw new Error(
    `Secret "${name}": unsupported scheme "${scheme}". Use env://VAR, file:///path, or keychain://service/account.`
  );
}
