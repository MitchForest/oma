export type DiffIndex = Map<string, Set<number>>;

export function parseChangedRightLines(diff: string): DiffIndex {
  const index: DiffIndex = new Map();
  let currentFile: string | undefined;
  let rightLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      if (!index.has(currentFile)) {
        index.set(currentFile, new Set());
      }
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      rightLine = Number(hunk[1]);
      continue;
    }

    if (!currentFile || line.startsWith("--- ")) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      index.get(currentFile)?.add(rightLine);
      rightLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("--- ")) {
      continue;
    }

    rightLine += 1;
  }

  return index;
}

export function hasChangedLine(index: DiffIndex, file: string, line: number): boolean {
  return index.get(file)?.has(line) ?? false;
}
