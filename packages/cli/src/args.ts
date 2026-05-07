import { CliError } from "./errors";

export type ParsedArgs = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string[]>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    if (!rawName) {
      throw new CliError(`Invalid flag: ${arg}`);
    }

    const next = argv[index + 1];
    const values = flags.get(rawName) ?? [];

    if (inlineValue !== undefined) {
      values.push(inlineValue);
    } else if (next && !next.startsWith("--")) {
      values.push(next);
      index += 1;
    } else {
      values.push("true");
    }

    flags.set(rawName, values);
  }

  const [command, ...rest] = positionals;
  return {
    command,
    flags,
    positionals: rest,
  };
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}
