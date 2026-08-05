# Parallel development workflow — IndianOpenBot

Developing the **robot app**, **web controller**, and **signaling server** in parallel
from a single fork — running two or more at once, on different branches, without
duplicate clones.

- Fork (`origin`): `git@github.com:LakshmiNaani/IndianOpenBot.git`
- Upstream: `https://github.com/ob-f/OpenBot.git`
- This document is **tracked at the repo root on `master`** (moved there 2026-08-05; it
  previously sat loose in `openbot/` and was not version-controlled at all). Edit it in
  `openbot/master/`, commit on `master`, and it reaches the other worktrees through the
  normal fan-out in §6.

---

## 1. Current state

Built 2026-08-02. Migration of existing work completed 2026-08-05.

| Folder | Cone | Size | Notes |
|---|---|---|---|
| `openbot/.bare/` | — | 243 MB | shared object store |
| `openbot/master/` | `android controller` | 30 MB | always on `master` |
| `openbot/integration/` | `android controller` | 30 MB | always on `integration` |
| `openbot/robot/` | `android` | 15 MB | holds whichever `robot_*` branch you are on |
| `openbot/web/` | `controller/web-server/client` | 780 KB | holds whichever `ctrl_*` branch you are on |
| `openbot/server/` | `controller/web-server/server` | 232 KB | always on `server/main` |
| | | **319 MB** | |

The trunk branches (`integration`, `robot/main`, `web/main`, `server/main`) all sit at
`87a9d17`, the upstream master tip; `master` is that plus this document. Four feature
branches carry the migrated work — see §5 for what each one is and §10 for where it
came from.

There was briefly a separate `main` branch acting as the upstream mirror alongside
`master`. It was redundant — two names for the same thing — and having a local `main`
next to `upstream/master` invited the wrong command. Collapsed into `master` on
2026-08-05; the folder `openbot/main/` became `openbot/master/`.

Verified working:

- Sparse isolation — `robot/` contains `android/` and nothing else; `web/` correctly
  retains `controller/web-server/package.json` and `vite.config.js` while excluding
  `server/`
- Merging out-of-cone changes into a sparse worktree (see §3)
- Fanning `master` out to a component main that is *not* checked out anywhere (§6)
- Integrating either component pair cleanly, and the fact that the two pairs conflict
  with each other by design (§7)
- KDiff3 installed and wired into git as `diff.tool` / `merge.tool`, ignore patterns applied

> **Known gap — the `pre-commit` hook no longer fires.** It matches `robot/*`, `web/*`,
> `server/*` (with slashes). The feature branches are named `robot_*` and `ctrl_*`, which
> fall through to the `*) exit 0` catch-all, so **none of them have path-ownership
> enforcement**. Fix is one line per case — see §4.

> **Known gap — the signaling server has no migrated work.** `server/main` is plain
> upstream. Both `*_cloud_multi_viewer` branches assume a server that understands
> `role:'bot'`/`role:'viewer'`, routes by `viewerId`, and emits `PEER_JOINED`/`PEER_LEFT`.
> That code exists only on the deployed Render instance, not in any clone. Pull it down
> before deleting the old clones (§10).

---

## 2. The core idea

The three components live in disjoint directories:

| Component | Directory |
|---|---|
| Robot app (Android) | `android/` |
| Web controller | `controller/web-server/client/` |
| Signaling server | `controller/web-server/server/` |

They share **no source file**. The protocol terms (`offer`, `answer`, `roomId`,
`iceCandidate`) are implemented separately in Java and JavaScript. The coupling is a
*wire protocol*, not shared code.

Two consequences drive everything below:

1. Branches that stay inside their own directory **never conflict with each other**.
   The isolation is free — it comes from the layout, not from deleting files.
2. Git can never detect protocol drift. Merges stay clean even when the robot and the
   controller have stopped being able to talk. That is what integration exists for (§7).

### Do not delete other components in your branches

A deletion is a tracked change. If `robot/main` deletes `controller/`, that deletion
merges into everything you merge `robot/main` into. Worse, every upstream change to
`controller/` becomes a delete/modify conflict you re-resolve forever. And it does not
achieve the goal anyway: **git has no partial-tree merge** — a merge is whole-tree by
definition.

Sparse-checkout is the correct tool. It hides other components from your working
directory without touching the committed tree.

---

## 3. Layout: one `.git`, several folders

**You cannot have three sparse checkouts in one folder.** A folder has exactly one
`HEAD`, so it is on exactly one branch with one sparse config. That is precisely why the
old setup needed four clones.

`git worktree` gives *sibling folders* sharing a single object store, each with its own
`HEAD` and its own sparse config at `.bare/worktrees/<name>/info/sparse-checkout`:

```
~/StudioProjects/openbot/
├── .bare/        # the ONE shared object store — never edit files here
├── master/       # master       cone: android controller   (upstream mirror)
├── integration/  # integration  cone: android controller   (end-to-end testing)
├── robot/        # robot/main   cone: android
├── web/          # web/main     cone: controller/web-server/client
└── server/       # server/main  cone: controller/web-server/server
```

Open `robot/` in Android Studio and `web/` in VS Code simultaneously — different
branches, both live, no interference.

### Merging into a sparse worktree is safe

Verified empirically: a commit modifying `docs/README.md` was merged into `robot/`
(cone = `android` only). The merge succeeded, `docs/` was **never written to disk**, the
change was correctly present in the committed tree, and the worktree stayed clean.

Sparse-checkout controls only what gets materialized. Merges operate on the tree and
index regardless. This is not a caveat you need to work around.

### Constraint

Git refuses to check out the *same branch* in two worktrees. If you need a second folder
on an already-checked-out branch, use `git worktree add --detach ../run <branch>` for a
read-only runner.

---

## 4. How this was built

Recorded so it can be reproduced or repaired.

```bash
# 1. bare clone from the existing fork clone (local, no network)
mkdir -p ~/StudioProjects/openbot
git clone --bare ~/StudioProjects/Fork/IndianOpenBot ~/StudioProjects/openbot/.bare

# 2. remotes
cd ~/StudioProjects/openbot/.bare
git remote set-url origin git@github.com:LakshmiNaani/IndianOpenBot.git
git remote add upstream https://github.com/ob-f/OpenBot.git
git config remote.origin.fetch   '+refs/heads/*:refs/remotes/origin/*'
git config remote.upstream.fetch '+refs/heads/*:refs/remotes/upstream/*'
git fetch --all

# 3. branches
#    NOTE: created from local `master`, not `origin/master` — the origin fetch failed
#    with Permission denied (publickey). Both were at 87a9d17, so the result is
#    identical. Once SSH works, confirm with:
#      git fetch origin && git log --oneline -1 origin/master
for b in robot/main web/main server/main integration; do git branch -f "$b" master; done

# 4. worktrees
cd ~/StudioProjects/openbot
git -C .bare worktree add ../master      master
git -C .bare worktree add ../robot       robot/main
git -C .bare worktree add ../web         web/main
git -C .bare worktree add ../server      server/main
git -C .bare worktree add ../integration integration

# 5. sparse cones
git -C robot       sparse-checkout set android
git -C web         sparse-checkout set controller/web-server/client
git -C server      sparse-checkout set controller/web-server/server
git -C main        sparse-checkout set android controller
git -C integration sparse-checkout set android controller

# 6. neutralize the macOS case collision in every worktree (see §11)
for w in main integration robot web server; do
  git -C $w update-index --skip-worktree \
    open-code/src/assets/images/Line.png open-code/src/assets/images/line.png
  rm -rf $w/open-code
done
```

### The path-ownership hook

Worktrees share `.bare/hooks/`, so this installs once for all of them:

```bash
cat > ~/StudioProjects/openbot/.bare/hooks/pre-commit <<'EOF'
#!/bin/sh
branch=$(git rev-parse --abbrev-ref HEAD)
case "$branch" in
  robot/*)  scope='^android/' ;;
  web/*)    scope='^controller/web-server/client/' ;;
  server/*) scope='^controller/web-server/server/' ;;
  *)        exit 0 ;;
esac
stray=$(git diff --cached --name-only | grep -v "$scope")
if [ -n "$stray" ]; then
  echo "Branch '$branch' may only touch $scope"
  echo "Out of scope:"; echo "$stray" | sed 's/^/  /'
  echo "Commit to 'integration' instead if this change is genuinely cross-component."
  exit 1
fi
EOF
chmod +x ~/StudioProjects/openbot/.bare/hooks/pre-commit
```

Tested: an `android/` commit on `robot/main` passes; a `README.md` commit on the same
branch is rejected with the out-of-scope list. `master` and `integration` are deliberately
unguarded — keeping those clean is a matter of discipline.

> **This hook is currently inert for all feature branches.** Its cases match `robot/*`,
> `web/*`, `server/*` — with slashes. The 2026-08-05 naming convention (§5) produces
> `robot_aug5_…` and `ctrl_aug5_…`, which match none of them and fall through to
> `*) exit 0`. Fix by widening two cases:
>
> ```sh
> robot/*|robot_*) scope='^android/' ;;
> web/*|ctrl_*)    scope='^controller/web-server/client/' ;;
> ```
>
> Re-test both directions afterwards — an `android/` commit on a `robot_*` branch should
> pass, a root-level commit on the same branch should be rejected.

### IDEs

- Android Studio → `~/StudioProjects/openbot/robot/android`
- VS Code → `~/StudioProjects/openbot/web`
- Server → `cd ~/StudioProjects/openbot/server/controller/web-server/server && npm i`

Each keeps its own build output and `node_modules`. The Gradle cache in `~/.gradle` is
shared across worktrees automatically.

---

## 5. The branch model and daily workflow

### What each branch is for

| Branch | Role | You commit here? |
|---|---|---|
| `master` | Mirror of `upstream/master`, plus this document | **This document only** |
| `integration` | Disposable test bed for running all three components together | Never |
| `robot/main` | Component trunk for `android/`. PR target for `robot_*` | Only via PR |
| `web/main` | Component trunk for `controller/web-server/client/`. PR target for `ctrl_*` | Only via PR |
| `server/main` | Component trunk for `controller/web-server/server/` | Only via PR |
| `robot_<date>_<feature>` | Robot app work | Yes |
| `ctrl_<date>_<feature>` | Web controller work | Yes |

Naming convention, established 2026-08-05: robot branches carry `robot`, controller
branches carry `ctrl`, both followed by a short date and the feature —
`robot_aug5_cloud_multi_viewer`, `ctrl_aug5_simple_local_changes`.

### Why there is exactly one mirror branch, and why it is called `master`

There used to be two — `master` and `main` — holding the same commit. Collapsed on
2026-08-05. If you are tempted to add a `main` back, these are the reasons not to:

- **Upstream's default branch is `master`.** There is no `upstream/main` —
  `git rev-parse upstream/main` returns `fatal: Needed a single revision`. A local branch
  called `main` sitting next to `upstream/master` is an invitation to type
  `git merge upstream/main`, which fails in a confusing way. Same name on both sides
  removes the ambiguity entirely.
- **`master` is your fork's default branch on GitHub**, inherited from ob-f/OpenBot, and
  what `.bare`'s `HEAD` points at. Keeping it means neither has to change.
- **One mirror is the point.** It is the single place upstream enters this repo, so every
  other branch merges from one trusted definition of "what upstream is" rather than each
  hitting the network with its own idea of it.

### `master` vs `integration`

Same cone, same commit most of the time, completely different jobs:

| | `master` | `integration` |
|---|---|---|
| Answers | "What is upstream right now?" | "Do my components still talk to each other?" |
| Receives merges from | `upstream/master`, nothing else | `master` + your feature branches |
| Lifetime | Permanent, authoritative | **Disposable — reset it freely** |
| PR target? | No | No |

`integration` exists because merges between component branches are *always* clean — the
paths are disjoint. That is the trap, not the reassurance. See §7.

### Daily workflow

```bash
cd ~/StudioProjects/openbot/robot
git switch -c robot_aug6_reconnect robot/main
# ...edit android/ only...
git commit -am "robot: reconnect on ICE failure"
git push -u origin robot_aug6_reconnect
```

Branch off the **component main**, not `master`, and PR back to the component main. That
keeps each review scoped to one component's directory.

Note that the component mains carry no commits of their own today, so
`git switch -c <new> master` gives an identical starting tree. The reason to branch off
`robot/main` is for when it *does* carry shared per-component work — see below.

### Getting a clean base for a new branch

**Sparse-checkout is a property of the folder, not the branch.** The cone lives in
`.bare/worktrees/<name>/info/sparse-checkout`. It is not recorded in any commit and it
does not travel with a branch. So whatever you check out in `robot/`, you see `android/`
and nothing else — the clean single-component view is free, and no particular branch has
to exist to provide it.

That means a clean starting point is always just:

```bash
cd ~/StudioProjects/openbot/robot          # cone is already 'android'
git switch -c robot_sep1_whatever master   # pure upstream + this doc, no other branch's smells
```

**Never branch from `integration`.** It is the dirtiest branch in the repo by design — it
carries whichever component pair was last merged in for testing, so a branch cut from it
inherits either the LAN or the cloud configuration depending on when you cut it. That is
exactly the contamination you are trying to avoid.

If you want a second folder so two branches of the same component are live at once:

```bash
git -C .bare worktree add ~/StudioProjects/openbot/robot2 -b robot_sep1_other master
git -C robot2 sparse-checkout set android
# then re-apply the Line.png skip-worktree fix from §11
```

**When the component mains earn their keep:** only once `robot/main` carries work that is
ahead of `master` and shared by more than one robot branch — a fix both the LAN and cloud
variants need, say. Then branching from `robot/main` gives you that shared baseline and
branching from `master` does not. Until such work exists they are aliases for `master`,
and they cost you the fan-out step in §6. They are also trivial to recreate:
`git branch robot/main master`.

### The hook

Note that the `pre-commit` path-ownership hook does **not** currently match these branch
names (§1, §4) — until that is fixed, staying inside `android/` is on you, not the hook.

### Opening the PR — check the base repository

GitHub defaults the base of any PR from a fork to the fork's **parent**, `ob-f/OpenBot`.
Push destination and PR destination are independent: your branch lands in your fork, but
the PR gets filed in ob-f's tracker, publicly, notifying their maintainers.

There is no setting to change this default. Either switch the **base repository** dropdown
on the compare page from `ob-f/OpenBot` to `LakshmiNaani/IndianOpenBot`, or skip it with a
direct URL that pins both ends to your fork:

```
https://github.com/LakshmiNaani/IndianOpenBot/compare/robot/main...<your-branch>?expand=1
https://github.com/LakshmiNaani/IndianOpenBot/compare/web/main...<your-branch>?expand=1
```

The tell that you are pointed at the wrong base: `robot/main`, `web/main` and `server/main`
do not exist in `ob-f/OpenBot`, so the base branch dropdown will not offer them. Ignore the
"Compare & pull request" banner that appears after a push — it goes straight to the
upstream-based form.

---

## 6. Syncing with upstream

Three steps, in order. Do step 1 **once**, in `main/`. Never sync in several places.

### Step 1 — bring upstream into `master`

```bash
cd ~/StudioProjects/openbot/master
git fetch upstream
git merge upstream/master
git push origin master
```

Note `master` here is your local branch and `upstream/master` is ob-f's. Same name, two
different refs; that is deliberate (§5).

This used to be `git merge --ff-only`, on the rule that the mirror must never carry
commits of its own — a fast-forward failure then meant something had been committed by
mistake. Since 2026-08-05 it carries exactly one thing of its own, this document, so the
fast-forward guarantee is gone and `--ff-only` would fail every sync. A plain merge is
correct now.

The guard it replaced is worth keeping by hand: **`master` should differ from
`upstream/master` by this file and nothing else.** Check it before every sync —

```bash
git diff --name-only upstream/master...master   # expect exactly: CONTRIBUTING-workflow.md
```

If anything else appears, it was committed to `master` by mistake; move it to the branch
that owns it.

`git push origin master` needs a loaded key — `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`.

### Step 2 — fan out to the component mains

The original version of this section assumed each component worktree was sitting on its
own component main. That is no longer true: `robot/` and `web/` hold feature branches
most of the time. Which command you need depends on whether the target branch is
currently checked out somewhere.

```bash
# Component main NOT checked out in any worktree -> fast-forward the ref directly.
# No worktree is touched, no branch switching required.
git -C master fetch . master:robot/main master:web/main

# Component main IS checked out in its worktree -> go there and merge.
cd ~/StudioProjects/openbot/server && git merge master
```

`git fetch . <src>:<dst>` refuses anything that is not a fast-forward, so it cannot
silently clobber work. It also errors out if `<dst>` happens to be checked out somewhere
— which is exactly the signal to use the second form instead.

**Prefer the first form wherever it applies.** Switching branches inside `robot/` has a
real cost: `android/robot/google-services.json` is *tracked* on `master` but *gitignored*
on the feature branches, so checking out a `master`-based branch overwrites your local
Firebase credentials with upstream's `opencode-openbot` copy. This happened on
2026-08-05; the file was recovered from the old clones. Avoid the switch and you avoid
the problem.

### Step 3 — bring the component main into your feature branch

```bash
cd ~/StudioProjects/openbot/robot
git switch robot_aug5_simple_local_changes
git merge robot/main
```

Rebase or merge depends on one thing only — whether the branch has been pushed:

| Branch state | Do | Why |
|---|---|---|
| Not yet pushed | `git rebase robot/main` | Linear history, costs nothing |
| Already pushed | `git merge robot/main` | Rebasing rewrites published commits |

If you do want a rebase on a pushed branch, that is fine on a solo fork — just make it
deliberate: `git push --force-with-lease`, never bare `--force`.

Cadence: **monthly**, or when you need a specific upstream fix. Each component branch has
exactly one conflict surface — its own directory — so these merges stay small.

---

## 7. Integration: why, when, how often

### Why

Merges between component branches are conflict-free by construction, because the paths
are disjoint. That is convenient, and it is also the danger: **a clean merge is not
evidence that the components still work together.** Git cannot see that the robot now
sends a field the controller does not read. Nothing in version control will catch that.
Integration is the only place it surfaces.

Integration is not about resolving conflicts. It is about running the robot, controller,
and server together from one tree and confirming they still talk.

### When — the trigger

Integrate when a change touches the **protocol boundary**:

| Side | File |
|---|---|
| Robot | `android/robot/src/main/java/org/openbot/env/WebRtcServer.java` |
| Robot | `android/robot/src/main/java/org/openbot/env/PhoneController.java` |
| Web | `controller/web-server/client/webRTC/webrtc.js` |
| Web | `controller/web-server/client/websocket/connection.js` |
| Server | anything in `controller/web-server/server/` |

**If your commit touches one of these, integrate before merging to a component main.**
A change that avoids them — UI tweak, refactor, dependency bump — does not need a pass.

### How often

| Situation | Cadence |
|---|---|
| Commit touched a protocol file above | Same day, before the PR merges |
| Neither side touched protocol files | Not required |
| Safety net regardless of activity | Once a week |
| Before tagging a release / flashing a robot | Always |

The weekly pass exists because drift can arrive through a dependency bump or an upstream
merge, not only your own edits.

### How — one component pair at a time

The four feature branches are **two matched pairs**, each a complete robot↔controller
configuration:

| Mode | Robot side | Controller side | Signaling |
|---|---|---|---|
| LAN / local-first | `robot_aug5_simple_local_changes` | `ctrl_aug5_simple_local_changes` | `ws://<your-mac-ip>:8080`, server run locally |
| Cloud / multi-viewer | `robot_aug5_cloud_multi_viewer` | `ctrl_aug5_cloud_multi_viewer` | `wss://signallingserver-g4a6.onrender.com` |

**The two pairs cannot both be merged into `integration`.** They are alternatives, not
additions: each picks a different signaling URL in `PhoneController.java` and a different
signaling shape in `webrtc.js`. Verified 2026-08-05 — merging both robot branches
together conflicts in `PhoneController.java`, `WebRtcServer.java` and
`android/robot/.gitignore`. Each pair *alone* merges cleanly (12 and 14 files).

So integration tests one pair, and since `integration` is disposable, `reset --hard` is
the right verb — you are not preserving anything there:

```bash
cd ~/StudioProjects/openbot/integration

# Test the LAN pair
git reset --hard master
git merge --no-edit robot_aug5_simple_local_changes ctrl_aug5_simple_local_changes

# Later, test the cloud pair — throw the previous one away first
git reset --hard master
git merge --no-edit robot_aug5_cloud_multi_viewer ctrl_aug5_cloud_multi_viewer
```

Include `server/main` in the merge once the signaling server actually has work on it
(§1, known gap). Today it is plain upstream, so merging it changes nothing.

The `android controller` cone covers everything needed to run all three. Then:

1. Start the signaling server — `controller/web-server/server/`
2. Start the web controller — `controller/web-server/client/`
3. Build and run the robot app from `android/`
4. Connect the robot to the controller and drive it

If it works, `integration` is your known-good reference. If not, the break is a protocol
mismatch — fix it in the owning component branch and re-merge. Do not commit fixes
directly on `integration`.

---

## 8. Comparing branches with KDiff3

Installed at `/Applications/kdiff3.app`, CLI at `/opt/homebrew/bin/kdiff3`.

```bash
# folder-compare two branches without checking either out
git difftool -d main robot/main

# review a whole branch before opening the PR
git difftool -d main robot/feat-cloud-multi
```

### Git integration — applied

Installing the app is not enough; git has to be told which tool to open. Without this,
`git difftool` silently falls back to `/usr/bin/opendiff` (Apple's FileMerge) on macOS.

```bash
git config --global diff.tool kdiff3        # which tool `git difftool` opens
git config --global merge.tool kdiff3       # which tool `git mergetool` opens
git config --global difftool.prompt false   # stop asking before each file
```

Undo with `git config --global --unset diff.tool`.

### Ignore patterns — applied

Set in `~/Library/Preferences/kdiff3rc` under `[KDiff3 Options]`. If you ever need to
change them, quit KDiff3 first — it rewrites this file on exit.

```ini
DirAntiPattern=CVS;.deps;.svn;.hg;.git;node_modules;build;.gradle;.idea;dist;.firebase;__pycache__;.cxx;.externalNativeBuild
FileAntiPattern=*.orig;*.o;*.obj;*.rej;*.bak;.DS_Store;*.iml;*.log;local.properties
ShowIdenticalFiles=false
```

`ShowIdenticalFiles=false` lists only deltas, which is what makes a folder comparison
readable on a repo this size.

Note: `git difftool -d` shows nothing at all when the two refs are identical — that is
correct behaviour, not a broken tool.

---

## 9. Disk

| | Before | After |
|---|---|---|
| Old clones (`Local_First_*`, `Cloud_multi_*`, `Fork/`) | 6.3 GB | — |
| `openbot/` worktree setup | — | 319 MB |

Builds and `node_modules` will add roughly 530 MB, landing near 850 MB.

`docs/` alone is 147 MB of GIFs and `body/` is 50 MB of CAD; both are excluded from every
cone. The code you actually develop is `android/` at 13 MB and `controller/` at 15 MB.

To temporarily see excluded directories: `git sparse-checkout disable`, then
`git sparse-checkout set android controller` to restore.

---

## 10. Migrating existing work — done 2026-08-05

All four legacy branches have been migrated. Where each landed:

| Legacy source | Winning tip | Migrated to | Commit |
|---|---|---|---|
| `v1_indianawa` (android side) | `e8453a2` | `robot_aug5_simple_local_changes` | `12134b5` |
| `v1_indianawa` (controller side) + `webserver_indianawa_v1` | `e8453a2` / `0ec1367` | `ctrl_aug5_simple_local_changes` | `d8b11e9` |
| `cloud_android` (uncommitted tree) | — | `robot_aug5_cloud_multi_viewer` | `22102f6` |
| `cloud_web_controller` (uncommitted tree) | — | `ctrl_aug5_cloud_multi_viewer` | `f543789` |

The 3 uncommitted files in `Local_First_OpenBot_Controller` needed no separate branch —
they were byte-identical to what `robot_aug5_simple_local_changes` already carried.

Credentials were moved out of source during the migration rather than carried across:
the web controller reads Firebase config from a gitignored `controller/web-server/.env`
(documented by `.env.example`), and `GoogleServices.java` reads the OAuth client ID from
the generated `R.string.default_web_client_id` instead of a literal.

**Do not delete the old clones yet** — the signaling server work is still missing (§1).
The analysis below is kept for provenance.

### Committed history

Investigated by ancestry, and it converges cleanly — these are fast-forwards, not merges:

| Branch name | Variants found | Resolution |
|---|---|---|
| `v1_indianawa` | `7d97c8f`, `88cdc74`, `e8453a2` | **`e8453a2` wins** — the others are its ancestors |
| `webserver_indianawa_v1` | `fa741fd`, `0ec1367` | **`0ec1367` wins** — `fa741fd` is its ancestor |
| `cloud_android` | `46aae68` | **zero own commits** — plain upstream master |
| `cloud_web_controller` | `46aae68` | **zero own commits** — plain upstream master |

`e8453a2` lives in `Local_First_OpenBot`; `0ec1367` in the two `*_Controller` clones.

### Uncommitted work — where the real value is

The two `cloud_*` branches are empty shells. Their actual content is uncommitted:

| Clone | Branch | Dirty | Changes | Suggested target |
|---|---|---|---|---|
| `Cloud_multi_OpenBot_android` | `cloud_android` | 10 | 5 files, `android/robot/` (WebRTC/cloud-multi) | `robot/cloud-multi` |
| `Cloud_multi_OpenBot_Controller` | `cloud_web_controller` | 17 | 7 files, `controller/web-server/client/` | `web/cloud-multi` |
| `Local_First_OpenBot_Controller` | `master` | 8 | 3 files, `android/robot/` (ControllerConfig, preferences) | `robot/controller-config` |

Snapshot them before anything else:

```bash
cd ~/StudioProjects
for d in Local_First_OpenBot_Controller Cloud_multi_OpenBot_android Cloud_multi_OpenBot_Controller; do
  git -C $d diff > ~/Desktop/$d.patch
done
```

### Two things needing a decision

- **`PhoneController.java` is edited uncommitted in both** `Cloud_multi_OpenBot_android`
  and `Local_First_OpenBot_Controller`, from the same base. These must be reconciled by
  hand — a good first job for KDiff3.
- **`google-services.json` and `bkup_google-services.json`** carry Firebase project
  credentials. The fork is public. Keep them out of any pushed branch.

### Before pushing

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
git -C ~/StudioProjects/openbot/.bare fetch origin    # must succeed
```

### Only after everything is verified

Delete the old clones — `Local_First_OpenBot`, `Local_First_OpenBot_Controller`,
`Cloud_multi_OpenBot_android`, `Cloud_multi_OpenBot_Controller`, and `Fork/` (its objects
now live in `.bare/`). Confirm the branches build and run from the worktrees first.

---

## 11. Gotchas

- **Same branch, two worktrees** — refused by git. Use `git worktree add --detach`.
- **`git checkout master` from an arbitrary folder does not work.** Each worktree owns
  one branch, and git refuses to check out a branch already checked out elsewhere. `cd`
  to the folder that holds it instead of switching to it.
- **Switching branches in `robot/` overwrites `google-services.json`.** It is tracked on
  `master` and gitignored on the feature branches, so checking out a `master`-based branch
  replaces your local Firebase credentials with upstream's `opencode-openbot` copy, with
  no warning — git overwrites ignored untracked files freely. Prefer the
  `git fetch . master:robot/main` form in §6 so you never have to switch. If it does
  happen, the file is recoverable from the old clones.
- **`git worktree move` resolves relative paths against `-C`, not your shell.**
  `git -C .bare worktree move main master` puts the worktree *inside* `.bare/`. Use
  absolute paths for both arguments. (Hit on 2026-08-05 during the `main` collapse;
  moving it back out with absolute paths fixed it cleanly.)
- **Removing a worktree** — use `git worktree remove <path>`, not `rm -rf`, or you leave
  a stale registration. `git worktree prune` cleans up afterwards.
- **`.bare/` is not a working directory.** Never edit files there.
- **`git status` in a sparse worktree** will not show files outside the cone. They are
  not deleted, merely not materialized.
- **`open-code/.../Line.png` shows as deleted** — the repo tracks both `Line.png` and
  `line.png`, which macOS's case-insensitive filesystem cannot hold separately. Full
  checkouts cope; sparse-checkout surfaces it as a phantom deletion. Already neutralized
  in all five worktrees. **Re-apply whenever you create a new sparse worktree:**

  ```bash
  git update-index --skip-worktree \
    open-code/src/assets/images/Line.png open-code/src/assets/images/line.png
  ```

  `open-code/` is outside every cone, so nothing is lost.
- **`Permission denied (publickey)` on push** — run
  `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`.
- **Root `.gitignore` is present** in every sparse worktree (cone mode keeps root-level
  files), so ignore rules apply normally.
