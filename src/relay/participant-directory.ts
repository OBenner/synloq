import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest } from "../config/manifest.js";
import type { Participant } from "../domain/message.js";

// Issue #36 (T2): the relay used to read synloq.yaml once at startup, so
// adding a role required a relay restart. The directory keeps the registry
// hot: it re-reads the manifest when the file changes and once more when a
// recipient is unknown. A broken manifest never takes the relay down — the
// last good snapshot keeps serving and the degradation is audited.

export interface ParticipantDirectory {
  list(project: string): Promise<Participant[]>;
  isParticipant(project: string, agentId: string): Promise<boolean>;
  // Force a re-read regardless of the mtime cache. Returns the snapshot that
  // is in effect afterwards (the last good one when the re-read fails).
  refresh(): Promise<Participant[]>;
}

export class StaticParticipantDirectory implements ParticipantDirectory {
  constructor(private readonly participants: Participant[]) {}

  list(project: string): Promise<Participant[]> {
    return Promise.resolve(
      this.participants.filter((participant) => participant.project === project),
    );
  }

  async isParticipant(project: string, agentId: string): Promise<boolean> {
    return (await this.list(project)).some((participant) => participant.agentId === agentId);
  }

  refresh(): Promise<Participant[]> {
    return Promise.resolve(this.participants);
  }
}

export interface ManifestParticipantDirectoryOptions {
  // Called once per transition into the degraded state (a reload failed while
  // serving). Repeated failures do not re-trigger the hook.
  onDegraded?: (error: unknown) => void;
}

export class ManifestParticipantDirectory implements ParticipantDirectory {
  private snapshot: Participant[] = [];
  private loadedMtimeMs: number | undefined;
  private reloading: Promise<boolean> | undefined;
  private degraded = false;

  private constructor(
    private readonly projectRoot: string,
    private readonly options: ManifestParticipantDirectoryOptions,
  ) {}

  // Initial load stays fail-fast: a relay must not start on an unreadable
  // manifest. Only reloads after a successful start are fail-closed.
  static async load(
    projectRoot: string,
    options: ManifestParticipantDirectoryOptions = {},
  ): Promise<ManifestParticipantDirectory> {
    const directory = new ManifestParticipantDirectory(projectRoot, options);
    directory.snapshot = await loadManifest(projectRoot);
    directory.loadedMtimeMs = await directory.mtimeMs();
    return directory;
  }

  async list(project: string): Promise<Participant[]> {
    await this.reloadIfChanged();
    return this.snapshot.filter((participant) => participant.project === project);
  }

  async isParticipant(project: string, agentId: string): Promise<boolean> {
    return (await this.list(project)).some((participant) => participant.agentId === agentId);
  }

  async refresh(): Promise<Participant[]> {
    await this.reload(true);
    return this.snapshot;
  }

  private async mtimeMs(): Promise<number | undefined> {
    try {
      return (await stat(join(this.projectRoot, "synloq.yaml"))).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private async reloadIfChanged(): Promise<void> {
    const mtimeMs = await this.mtimeMs();
    if (mtimeMs === undefined || mtimeMs === this.loadedMtimeMs) return;
    await this.reload(false);
  }

  private reload(force: boolean): Promise<boolean> {
    // Single-flight: concurrent requests share one manifest re-read.
    this.reloading ??= this.performReload(force).finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  private async performReload(force: boolean): Promise<boolean> {
    const mtimeMs = await this.mtimeMs();
    if (!force && mtimeMs === this.loadedMtimeMs) return false;
    try {
      const participants = await loadManifest(this.projectRoot);
      this.snapshot = participants;
      this.loadedMtimeMs = mtimeMs ?? (await this.mtimeMs());
      this.degraded = false;
      return true;
    } catch (error) {
      // Fail-closed: keep serving the last good snapshot, audit once per
      // transition into the degraded state.
      if (!this.degraded) {
        this.degraded = true;
        this.options.onDegraded?.(error);
      }
      return false;
    }
  }
}
