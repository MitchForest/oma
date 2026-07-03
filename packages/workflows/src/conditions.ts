export interface UntilCondition {
  stage: string;
  field: string;
  operator: "==" | "!=";
  value: string | number | boolean;
}

const conditionPattern = /^\s*([\w-]+)\.([\w-]+)\s*(==|!=)\s*(.+?)\s*$/;

/**
 * The whole loop condition language: `<stage>.<field> == literal` (or `!=`).
 * Anything richer belongs in a code workflow (`run:`), not in YAML.
 */
export function parseUntilCondition(text: string): UntilCondition | undefined {
  const match = conditionPattern.exec(text);

  if (!match) {
    return undefined;
  }

  return {
    stage: match[1]!,
    field: match[2]!,
    operator: match[3] as "==" | "!=",
    value: parseLiteral(match[4]!)
  };
}

export function evaluateUntilCondition(
  condition: UntilCondition,
  output: Record<string, unknown> | undefined
): boolean {
  const actual = output?.[condition.field];
  const matches = actual === condition.value;
  return condition.operator === "==" ? matches : !matches;
}

function parseLiteral(raw: string): string | number | boolean {
  const unquoted = /^(["'])(.*)\1$/.exec(raw);

  if (unquoted) {
    return unquoted[2]!;
  }

  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  const asNumber = Number(raw);

  if (raw !== "" && Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(raw)) {
    return asNumber;
  }

  return raw;
}
