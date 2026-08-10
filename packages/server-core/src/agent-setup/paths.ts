import path from "node:path";
import { SUPERSET_HOME_DIR } from "../app-environment";

export const BIN_DIR = path.join(SUPERSET_HOME_DIR, "bin");
/** Where the packaged `ade` CLI bundle is staged. See ade-cli-bin.ts. */
export const CLI_DIR = path.join(SUPERSET_HOME_DIR, "cli");
export const HOOKS_DIR = path.join(SUPERSET_HOME_DIR, "hooks");
/** Bundled agent skills, installed by agent-setup. See ade-workspace-skill.ts. */
export const SKILLS_DIR = path.join(SUPERSET_HOME_DIR, "skills");
export const ZSH_DIR = path.join(SUPERSET_HOME_DIR, "zsh");
export const BASH_DIR = path.join(SUPERSET_HOME_DIR, "bash");
export const OPENCODE_CONFIG_DIR = path.join(HOOKS_DIR, "opencode");
export const OPENCODE_PLUGIN_DIR = path.join(OPENCODE_CONFIG_DIR, "plugin");
