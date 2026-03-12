import { homedir } from "node:os";
import { join } from "node:path";
import { xdgConfig } from "xdg-basedir";

export function getOneConfigDir(): string {
  return join(xdgConfig ?? join(homedir(), ".config"), "one");
}

export function getOneConfigPath(fileName: string): string {
  return join(getOneConfigDir(), fileName);
}
