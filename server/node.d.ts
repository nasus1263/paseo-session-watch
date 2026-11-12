// The plugin typechecks without @types/node; declare only the Node APIs the server uses.
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function rename(from: string, to: string): Promise<void>;
  export function mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  export function readdir(path: string): Promise<string[]>;
  export function stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:child_process" {
  export function execFile(
    file: string,
    args: string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): unknown;
}

declare const process: { env: Record<string, string | undefined> };
