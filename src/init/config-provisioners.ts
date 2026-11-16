import type { HostName } from "../config/hosts.js";
import type { ProjectPaths } from "../config/paths.js";
import type { TeamState } from "../config/team-state.js";
import {
  inspectDesktopDirectory,
  provisionDesktopRoles,
  removeDesktopDirectory,
} from "./codex-desktop.js";
import { resolvePlacement } from "./placement.js";
import type { ReconcileOptions } from "./reconcile.js";

export interface ConfigInspection {
  path: string;
  ok: boolean;
  issue?: string;
}

export interface ConfigContext {
  projectRoot: string;
  paths: ProjectPaths;
  agentId: string;
  placement?: NonNullable<TeamState["placements"]>[string];
}

export interface ProvisionedConfigs {
  roles: Array<{ agentId: string; directory: string; configPath: string; credentialPath: string }>;
  nextSteps: string[];
}

export interface ConfigProvisioner {
  provision(options: ReconcileOptions): Promise<ProvisionedConfigs>;
  inspect(context: ConfigContext): Promise<ConfigInspection>;
  remove(context: ConfigContext): Promise<string>;
}

export type ConfigProvisionerRegistry = Partial<Record<HostName, ConfigProvisioner>>;

export const CONFIG_PROVISIONERS: ConfigProvisionerRegistry = {
  "codex-desktop": {
    provision: provisionDesktopRoles,
    async inspect({ projectRoot, paths, agentId, placement }) {
      try {
        const directory = await resolvePlacement(projectRoot, paths, agentId, placement?.directory);
        return await inspectDesktopDirectory(
          paths.runtime,
          agentId,
          placement?.desktopFiles,
          directory,
        );
      } catch {
        return {
          path: placement?.directory ?? "",
          ok: false,
          issue: "stored placement is invalid or redirected",
        };
      }
    },
    async remove({ projectRoot, paths, agentId, placement }) {
      try {
        const directory = await resolvePlacement(projectRoot, paths, agentId, placement?.directory);
        return await removeDesktopDirectory(
          paths.runtime,
          agentId,
          placement?.desktopFiles,
          directory,
        );
      } catch {
        return "Role directory retained: stored placement is invalid or redirected";
      }
    },
  },
};
