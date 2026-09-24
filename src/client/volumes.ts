/**
 * 「新建卷」: the one place that knows what creating a volume means.
 *
 * Two surfaces offer the button — the outline page (next to the volume picker) and
 * the chapter tree (where the volumes are the rows the author is looking at), and
 * they must do exactly the same thing: write `outline/volumes/vNN.md` with the
 * shared skeleton (`paths.ts`), nothing else. No `chapters/vNN/` directory and no
 * empty chapter are pre-created (format §1: empty directories appear with their
 * first file), because the volume's *existence* is already established by its
 * outline — see `03` §4.11 and `mergeVolumes` in `novel/project.ts`.
 *
 * @module dsh-ai-novel-copilot/client/volumes
 */
import { volumeOutlinePath, volumeOutlineSkeleton } from '../novel/paths.ts'
import type { VolumeSummary } from '../novel/project.ts'
import * as api from './api.ts'

/**
 * The next volume number.
 *
 * Derived from the last entry rather than a stored counter: `snapshot.volumes`
 * arrives sorted ascending and a volume exists as soon as its outline file does,
 * so one past the highest is free. A counter somewhere would be a second truth
 * that a hand-written `v03.md` could contradict.
 * @param volumes - every volume the project knows about, ascending.
 * @returns the volume number to create.
 */
export function nextVolumeNumber(volumes: readonly VolumeSummary[]): number {
  return (volumes.at(-1)?.volume ?? 0) + 1
}

/** What one 新建卷 wrote. */
export interface CreatedVolume {
  /** The number the new volume got. */
  volume: number
  /** The outline path that was written. */
  path: string
  /** Whether the file was created or replaced. */
  operation: string
  /** Bytes written. */
  bytes: number
}

/**
 * Write the next volume's outline skeleton.
 *
 * A write through the ordinary document channel, so the new file is versioned in
 * the modification record like every other document (format §4.9) — creating a
 * volume is an edit the author may want to undo.
 * @param sessionId - session whose sandbox the write runs under.
 * @param root - project root.
 * @param volumes - every volume the project knows about, ascending.
 * @returns what was written.
 */
export async function createNextVolume(
  sessionId: string,
  root: string,
  volumes: readonly VolumeSummary[],
): Promise<CreatedVolume> {
  const volume = nextVolumeNumber(volumes)
  const path = volumeOutlinePath(volume)
  const written = await api.writeDocument(sessionId, root, path, {}, volumeOutlineSkeleton(volume))
  return { volume, path, operation: written.operation, bytes: written.after.length }
}

/**
 * How the author is told what just happened.
 *
 * Both surfaces say the same thing because it is the same fact: the volume now
 * exists everywhere, and it has no chapters yet.
 * @param created - the result of {@link createNextVolume}.
 * @returns one status line.
 */
export function createdVolumeNote(created: CreatedVolume): string {
  return `已新建 ${created.path}（${created.operation === 'create' ? '新建' : '覆盖'}，${String(created.bytes)} 字节）；这一卷还没有章节，可以「按卷纲拆章」或点它的「＋ 新建章节」开第一章`
}
