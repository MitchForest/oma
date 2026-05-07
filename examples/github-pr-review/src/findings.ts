import type { ReviewFinding, ReviewFindingsArtifact } from "./types";

const severities = new Set(["blocking", "high", "medium", "low"]);
const confidences = new Set(["high", "medium", "low"]);
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

  const severity = stringField(value, "severity");
  const confidence = stringField(value, "confidence");
  const side = stringField(value, "side");
  if (!severities.has(severity)) {
    throw new Error(`Invalid finding severity: ${severity}`);
  }
  if (!confidences.has(confidence)) {
    throw new Error(`Invalid finding confidence: ${confidence}`);
  }
  if (!sides.has(side)) {
    throw new Error(`Invalid finding side: ${side}`);
  }

  const output: ReviewFinding = {
    id: stringField(value, "id"),
    severity: severity as ReviewFinding["severity"],
    confidence: confidence as ReviewFinding["confidence"],
    file: stringField(value, "file"),
    side: side as ReviewFinding["side"],
    title: stringField(value, "title"),
    body: stringField(value, "body"),
    evidence: stringArrayField(value, "evidence"),
  };

  if (typeof value.line === "number" && Number.isInteger(value.line)) {
    output.line = value.line;
  }
  if (typeof value.suggestion === "string" && value.suggestion.length > 0) {
    output.suggestion = value.suggestion;
  }

  return output;
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
      const location = finding.line ? `${finding.file}:${String(finding.line)}` : finding.file;
      const suggestion = finding.suggestion ? `\n\nSuggested fix:\n\n${finding.suggestion}` : "";
      return [
        `## ${finding.title}`,
        "",
        `- ID: ${finding.id}`,
        `- Severity: ${finding.severity}`,
        `- Confidence: ${finding.confidence}`,
        `- Location: ${location}`,
        "",
        finding.body,
        suggestion,
        "",
        "Evidence:",
        ...finding.evidence.map((item) => `- ${item}`),
      ].join("\n");
    })
    .join("\n\n");

  return `# PR Review Findings\n\n${artifact.summary}\n\n${findings}\n`;
}
