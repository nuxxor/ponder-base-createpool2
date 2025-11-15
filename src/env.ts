import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const customEnv = process.env.DOTENV_PATH;
const externalAiPipelineEnv = path.resolve(cwd, "../ai-pipeline/.env");
const defaultEnvFiles = [
  externalAiPipelineEnv,
  path.resolve(cwd, ".env"),
  path.resolve(cwd, ".env.local"),
];

const envFiles = [
  ...defaultEnvFiles,
  customEnv ? path.resolve(cwd, customEnv) : undefined,
].filter(Boolean) as string[];

for (const envPath of envFiles) {
  if (fs.existsSync(envPath)) {
    config({ path: envPath, override: true });
  }
}
