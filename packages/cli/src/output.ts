export type Output = {
  stdout: string[];
  stderr: string[];
};

export function text(output: Output, message: string): void {
  output.stdout.push(message);
}

export function errorText(output: Output, message: string): void {
  output.stderr.push(message);
}

export function json(output: Output, value: unknown): void {
  output.stdout.push(JSON.stringify(value, null, 2));
}
