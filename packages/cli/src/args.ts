export interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
  multiValues: Map<string, string[]>;
}

export interface ParseArgsSpec {
  /** Boolean flags this command accepts. */
  flags?: string[];
  /** Value-taking flags this command accepts. */
  values?: string[];
  /** Value-taking flags that may repeat (e.g. `--input k=v --input k2=v2`). */
  multi?: string[];
}

export function parseArgs(args: string[], spec: ParseArgsSpec = {}): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const multiValues = new Map<string, string[]>();
  const knownFlags = new Set(spec.flags ?? []);
  const valueFlags = new Set(spec.values ?? []);
  const multiFlags = new Set(spec.multi ?? []);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const name = arg.slice(2);

    if (!knownFlags.has(name) && !valueFlags.has(name) && !multiFlags.has(name)) {
      throw new Error(`Unknown flag: --${name}`);
    }

    flags.add(name);

    if (valueFlags.has(name) || multiFlags.has(name)) {
      const value = args[index + 1];

      if (!value) {
        throw new Error(`Missing value for --${name}`);
      }

      if (multiFlags.has(name)) {
        multiValues.set(name, [...(multiValues.get(name) ?? []), value]);
      } else {
        values.set(name, value);
      }

      index += 1;
    }
  }

  return { positionals, flags, values, multiValues };
}

/** Parses repeated `--flag key=value` pairs into a record. */
export function keyValuePairs(parsed: ParsedArgs, name: string): Record<string, string> {
  const pairs: Record<string, string> = {};

  for (const entry of parsed.multiValues.get(name) ?? []) {
    const separator = entry.indexOf("=");

    if (separator <= 0) {
      throw new Error(`--${name} expects key=value, got: ${entry}`);
    }

    pairs[entry.slice(0, separator)] = entry.slice(separator + 1);
  }

  return pairs;
}

export function numberFlag(
  parsed: ParsedArgs,
  name: string,
  options: { integer?: boolean; min?: number } = {}
): number | undefined {
  const value = parsed.values.get(name);

  if (value === undefined) {
    return undefined;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`Invalid number for --${name}: ${value}`);
  }

  if (options.integer && !Number.isInteger(number)) {
    throw new Error(`--${name} must be an integer: ${value}`);
  }

  if (options.min !== undefined && number < options.min) {
    throw new Error(`--${name} must be >= ${options.min}: ${value}`);
  }

  return number;
}


export async function parsePayloadFlag(value: string): Promise<unknown> {
  if (value.startsWith("@")) {
    return Bun.file(value.slice(1)).json();
  }

  return JSON.parse(value);
}
