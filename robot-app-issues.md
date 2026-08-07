# Robot app build issues — IndianOpenBot

Build failures hit while developing the **robot app** in the worktree layout, what caused
them, and what was done. Companion to `CONTRIBUTING-workflow.md`; the layout itself is
described in that document's §1–§3.

- This document is **tracked at the repo root on `master`**. Edit it in `openbot/master/`,
  commit on `master`, and it reaches the other worktrees the next time they merge `master`
  (workflow §6).
- Investigated 2026-08-06 / 07 against `robot_aug6_firsttest` at `450323f`.

---

## 1. Symptom

`:robot:assembleDebug` from `openbot/robot/android` failed with **7 task failures**. They
collapse into two entirely independent causes, which is what made the output confusing:

| Failing tasks | Cause |
|---|---|
| `mergeDebugResources`, `checkDebugAarMetadata`, `mapDebugSourceSetPaths`, `mergeDebugAssets`, `checkDebugDuplicateClasses`, `desugarDebugFileDependencies` | §3 — Jetifier `Unexpected end of ZLIB input stream` on `Wroup-master-release.aar` |
| `generateAppVersionInfoForDebug` | §2 — app-versioning cannot find the git root |

Six of the seven are the same single failure reported once per artifact-transform target.
Only §2 is deterministic; §3 has not been reproduced since.

---

## 2. Issue A — app-versioning fails in every worktree

**Status: fixed 2026-08-07.**

```
Execution failed for task ':robot:generateAppVersionInfoForDebug'.
> Android App Versioning Gradle Plugin works with git tags but root project 'android'
  is not a git root directory, and a valid gitRootDirectory is not provided.
```

### Why

`robot/build.gradle` already sets `gitRootDirectory.set(rootProject.file("../"))`, and that
path *is* correct — `openbot/robot` is what `git rev-parse --show-toplevel` reports. The
problem is one level deeper.

**In a git worktree, `.git` is a file, never a directory:**

```
$ cat openbot/robot/.git
gitdir: /Users/srikanth/StudioProjects/openbot/.bare/worktrees/robot
```

Decompiling `app-versioning-gradle-plugin-1.1.2.jar` shows it resolves
`<gitRootDirectory>/.git/HEAD` and `<gitRootDirectory>/.git/refs` as real filesystem paths
and fails its `isPresent` check when they do not exist. In this layout they never do.

This is **inherent to worktrees, not a mistake in our setup**. All five worktrees
(`integration`, `master`, `robot`, `server`, `web`) have `.git` as a file, so all five fail
identically — confirmed by running the task in `integration`, which has no local edits at
all. Switching folders to build is not a workaround. The only directory in the tree with a
real git dir is `.bare`, which has no working tree to build from.

### What was tried first, and why it was dropped

Adding `bareGitRepoDirectory` directly to `robot/build.gradle`:

```groovy
appVersioning {
    gitRootDirectory.set(rootProject.file("../"))
    def bareGitRepo = rootProject.file("../../.bare")     // reverted — do not re-add
    if (bareGitRepo.directory) { bareGitRepoDirectory.set(bareGitRepo) }
}
```

It worked, but it is the wrong home for the fix:

- `robot/build.gradle` is **tracked**, and each worktree has a different branch checked
  out — so the fix would only exist on whichever branch was edited. `integration` and
  `master` stay broken until it is merged across.
- It puts a machine-specific path into commits that eventually go upstream.

### What was done instead

A machine-local Gradle init script, **untracked and outside the repo**:

```
~/.gradle/init.d/app-versioning-worktree.gradle
```

It walks up from the root project to the enclosing `.git`. If that is a *directory* it does
nothing, so ordinary clones keep the plugin's own defaults. If it is a *file* it reads the
`gitdir:` pointer, then reads that directory's `commondir` (`../..` here) to resolve the git
dir shared by all worktrees — `openbot/.bare` — and sets `bareGitRepoDirectory` to it. It
only applies the override after confirming `HEAD` and `refs` genuinely exist there.

Nothing is hardcoded to `.bare` or to any absolute path; it is all derived from git's own
metadata, so a renamed bare directory or a new worktree still resolves.

One init script fixes **all five worktrees at once**, needs no merging between branches, and
leaves the tracked build files untouched.

### Verified

| Worktree | Before | After |
|---|---|---|
| `robot` | failed | `versionCode: 800`, `versionName: "v0.8.0"` |
| `integration` (no local edits) | failed | `versionCode: 800`, `versionName: "v0.8.0"` |

Both were forced with `--rerun-tasks`; the first attempt reported `UP-TO-DATE` from earlier
state, which would have been a false pass.

### Trade-offs accepted

- The script applies to **every** Gradle build on this machine. It is inert unless a project
  applies `io.github.reactivecircus.app-versioning` *and* sits in a worktree, so the blast
  radius is small — but it is global.
- It is **invisible to teammates and to CI**. Anyone else who moves to a worktree layout
  will hit the original error with no clue why this checkout works. That is the reason this
  document exists.
- If versioning breaks again on a fresh machine, or after a `~/.gradle` cleanup, **check the
  init script still exists before touching `robot/build.gradle`.**

---

## 3. Issue B — Jetifier `Unexpected end of ZLIB input stream`

**Status: not reproducible; no change made. Retry first if it recurs.**

```
Failed to transform 'comlib/libs/Wroup-master-release.aar' using Jetifier.
Reason: EOFException, message: Unexpected end of ZLIB input stream.
```

### The AAR is not corrupt

Ruled out three independent ways:

- `unzip -t` passes on the AAR and on the nested `classes.jar`.
- Every local file header matches the central directory (method, sizes, CRCs).
- The on-disk file is **byte-identical to the copy on the server** —
  SHA-256 `349347bcc434339ca31fb6580fff2c97f7b608cddf3e61f8d0392df534cf4558`.

A standalone Java program replicating Jetifier's exact nested-zip walk reads all 29 classes
out of `classes.jar` without error. So there is nothing wrong with the file as it sits now,
and re-downloading it changes nothing.

### Best explanation

A race. `comlib/libs/*.aar` are fetched at build time by `:comlib:downloadAars`, but nothing
orders that task against the code that consumes the files:

- `robot/build.gradle` uses `fileTree(dir: comlibDir, include: ['*.aar'])`, which resolves
  lazily at execution time and carries **no task dependency**.
- `comlib/build.gradle` guards its `api files(...)` with `if (file.exists())`, evaluated at
  **configuration** time — so on a clean checkout the AARs are not there yet and contribute
  nothing, leaving the unordered `fileTree` as the only path to them.

The original log supports this: the `Download …Wroup-master-release.aar` lines print *after*
the tasks that failed on that file. Jetifier read it mid-write, so the deflate stream was
truncated.

### What was tried, and why it was reverted

```groovy
// comlib/build.gradle — would replace the three if (…exists()) blocks
api files(googleWebrtcFile, wroupFile, usbserialFile).builtBy(downloadAars)

// robot/build.gradle line 78
implementation fileTree(dir: comlibDir, include: ['*.aar']).builtBy(':comlib:downloadAars')
```

Reverted. The error **could not be reproduced in three attempts** on the unmodified build
files — empty `libs/`, `clean`, downloads running during the build, `--continue` so nothing
aborted early. A clean build passing *with* the change proves nothing when it also passes
without it. Not worth carrying an unproven change.

The missing task dependency is nonetheless real, and has one deterministic consequence worth
knowing: `./gradlew :robot:mergeDebugResources` on a clean checkout downloads nothing at all
and merges without Wroup's resources. `assembleDebug` avoids this only because
`implementation project(':comlib')` happens to drag in `checkAars` → `downloadAars`.

### If it recurs

1. **Just retry.** A second run almost certainly succeeds — the files are complete by then,
   and `downloadAars` has `overwrite false`, so it will not rewrite them.
2. **The tell that it really is this race:** the `Download …` line for the named `.aar`
   appears in the log *after* the task that failed on it. If the download line comes first,
   it is something else — start by re-verifying the file as in the checks above.
3. Only if it becomes recurring, re-add the two `builtBy` lines above.

---

## 4. Verifying a healthy build

```bash
cd openbot/robot/android

# app versioning — --rerun-tasks matters, UP-TO-DATE hides a real failure
./gradlew :robot:generateAppVersionInfoForDebug --rerun-tasks
./gradlew :robot:printAppVersionInfoForDebug        # expect versionCode 800, "v0.8.0"

# worst-case cold build: forces the AAR download to run during the build
rm -f comlib/libs/*.aar
./gradlew clean && ./gradlew --stop
./gradlew :robot:assembleDebug                      # expect BUILD SUCCESSFUL, ~42 tasks
ls -la robot/build/outputs/apk/debug/robot-debug.apk
```

Last run clean from this state: `BUILD SUCCESSFUL in 23s`, 41 of 42 tasks executed, 41.5 MB APK.

---

## 5. Benign noise in the build log

Neither of these indicates a problem; do not chase them while debugging:

- **`We recommend using a newer Android Gradle plugin to use compileSdk = 34`** — AGP 7.4.2
  was tested to `compileSdk 33`. Silence with `android.suppressUnsupportedCompileSdk=34` in
  `gradle.properties` if it is distracting.
- **`Unable to strip the following libraries…`** — `libarcore_sdk_c.so`,
  `libjingle_peerconnection_so.so`, `libtensorflowlite_jni.so` and friends are packaged
  unstripped. Expected for these prebuilt `.so` files; it only costs APK size.
