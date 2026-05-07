import type { ReviewFinding, ReviewFindingsArtifact } from "./types";

const risks = new Set(["high", "medium", "low"]);
const confidences = new Set(["high", "medium", "low"]);
const categories = new Set([
  "api_contract",
  "backwards_compatibility",
  "concurrency",
  "data_integrity",
  "database_migration",
  "error_handling",
  "hidden_path",
  "logic_error",
  "observability",
  "performance",
  "security",
  "tech_debt",
  "test_gap",
  "unnecessary_shim",
]);
const sides = new Set(["RIGHT", "LEFT"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Finding field ${key} must be a non-empty string.`);
  }
  return value;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Finding field ${key} must be an array of strings.`);
  }
  return value;
}

function parseFinding(value: unknown): ReviewFinding {
  if (!isRecord(value)) {
    throw new Error("Each finding must be an object.");
  }

  const risk = stringField(value, "risk");
  const confidence = stringField(value, "confidence");
  const category = stringField(value, "category");
  const side = stringField(value, "side");
  if (!risks.has(risk)) {
    throw new Error(`Invalid finding risk: ${risk}`);
  }
  if (!confidences.has(confidence)) {
    throw new Error(`Invalid finding confidence: ${confidence}`);
  }
  if (!categories.has(category)) {
    throw new Error(`Invalid finding category: ${category}`);
  }
  if (!sides.has(side)) {
    throw new Error(`Invalid finding side: ${side}`);
  }
  if (typeof value.line !== "number" || !Number.isInteger(value.line)) {
    throw new Error("Finding field line must be an integer.");
  }

  return {
    id: stringField(value, "id"),
    risk: risk as ReviewFinding["risk"],
    confidence: confidence as ReviewFinding["confidence"],
    category: category as ReviewFinding["category"],
    file: stringField(value, "file"),
    line: value.line,
    side: side as ReviewFinding["side"],
    title: stringField(value, "title"),
    body: stringField(value, "body"),
    whyItMatters: stringField(value, "whyItMatters"),
    suggestedFix: stringField(value, "suggestedFix"),
    validation: stringArrayField(value, "validation"),
    evidence: stringArrayField(value, "evidence"),
  };
}

export function parseFindingsArtifact(content: string): ReviewFindingsArtifact {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Findings artifact must be an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("Findings artifact schemaVersion must be 1.");
  }
  if (typeof parsed.summary !== "string") {
    throw new Error("Findings artifact summary must be a string.");
  }
  if (!Array.isArray(parsed.findings)) {
    throw new Error("Findings artifact findings must be an array.");
  }

  return {
    schemaVersion: 1,
    summary: parsed.summary,
    findings: parsed.findings.map(parseFinding),
  };
}

export function renderFindingsMarkdown(artifact: ReviewFindingsArtifact): string {
  if (artifact.findings.length === 0) {
    return `# PR Review Findings\n\n${artifact.summary}\n\nNo findings.\n`;
  }

  const findings = artifact.findings
    .map((finding) => {
      const location = `${finding.file}:${String(finding.line)}`;
      return [
        `## ${finding.title}`,
        "",
        `- ID: ${finding.id}`,
        `- Risk: ${finding.risk}`,
        `- Confidence: ${finding.confidence}`,
        `- Category: ${finding.category}`,
        `- Location: ${location}`,
        "",
        finding.body,
        "",
        "Why it matters:",
        "",
        finding.whyItMatters,
        "",
        "Suggested fix:",
        "",
        finding.suggestedFix,
        "",
        "Evidence:",
        ...finding.evidence.map((item) => `- ${item}`),
        "",
        "Validation:",
        ...finding.validation.map((item) => `- ${item}`),
      ].join("\n");
    })
    .join("\n\n");

  return `# PR Review Findings\n\n${artifact.summary}\n\n${findings}\n`;
}
