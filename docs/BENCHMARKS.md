# The scorecard

What Invincible measures about itself that costs no model call: the algorithms, the machinery, and what the system
does as it is given more devices and more compute. One command:

```sh
bun run bench                       # every suite, against its recorded baseline
bun run bench fleet compute         # some suites
bun run bench --full                # the long sizes too
bun run bench --all                 # every metric, not just the headline ones and those that moved
bun run bench --json                # the scorecards and verdicts on stdout
bun run bench --ci                  # what CI gates on: quality only
bun run bench --seed 7              # other inputs
bun run bench --update-baseline     # record this run as the baseline, on purpose
```

It prints, for each suite, what it measured, the baseline, the change and a verdict; writes `bench/out/<suite>.json`;
and exits non-zero when something got worse.

## The rules

- **Programs grade, never models.** Every input is drawn from a seed (`--seed`, by default 20 261 112). The seed and the
  revision are in every scorecard.
- **Two kinds of metric, kept apart.**
  - **Quality** is a count or exact arithmetic on seeded inputs. One for the worse fails the run, and so does a metric
    the baseline had that the run doesn't report: a benchmark can't pass by measuring less. A metric may state a
    resolution, and a difference within it isn't a change.
  - **Speed** is a timing or a rate: the median of its samples, with their interquartile range, compared after scaling
    by the machine's calibration (`Pace` in `bench/lib.ts`). A difference inside the noise band (25 %, or 1.5 times the
    two runs' spreads added, whichever is more) is no change; slower beyond it is reported, and fails only past 2×,
    never under `--ci`. A strict suite (the desktop's) fails on any number worse than its baseline beyond its band.
- **Baselines are recorded on purpose**, one file a suite in `bench/baseline/`, reviewed like code. Only
  `--update-baseline` writes one.
- **Nothing is retried.** A slow timing is reported slow; a failure failed.
- **A suite that can't run here is skipped, and says so.** What it needs (Docker with Kata, say) isn't on this machine:
  the report and its JSON name it and why, and it is unverified, never a pass.

## The suites

| Suite | What it measures |
|---|---|
| fleet | N replicas over the real sync engine and a hostile network: do they converge, and what does a device cost? |
| compute | queues of runs on fleets of 1 to 8 machines, in virtual time: are ceilings kept, and what does a machine buy? |
| mind | what the replicated log costs at 4,000 and 16,000 events |
| archive | the archive's search on a labelled set, by words, by meaning and by both |
| harness-overhead | the chat loop and the run runner with models that answer at once |
| context | what a run sends its engineer over a whole run |
| notify | a seeded week of asks and news on two devices: are asks answered in time, and how often does it buzz? |
| web | the PWA's places on a laptop and a phone: how far what's on screen moves once it is there |
| desktop | an agent's desktop in a Kata microVM, as the node makes one (below) |

### desktop: an agent's desktop, fast and stable

An agent's VM made from the desktop image, with the node's own run arguments (Kata, a read-only root, no
capabilities, uid 1000, 1 vCPU and 4 GB), driven through the node's own paths: inside the VM, through the agent's path
(`SandboxHost.exec` of `bash -lc withGateway(…)`, as team-runtime runs every command of a task) and through the owner's
(`SandboxHost.desktop`, which is `POST /api/team/desktop` on the VM's host). Every page is served from the VM's own
loopback (`bench/desktop/kit/server.py`): its VMs have no network. Where an agent would ask its eyes, a stand-in answers
at once (for timing) or from the truth (the DOM, the window list: perfect targeting, for the tasks), so it measures
everything but the model.

- **What it needs:** Linux with Docker and Kata microVMs (`/dev/kvm`, `containerd-shim-kata-v2`). Anywhere else it is
  skipped and says so. It runs on a sandbox host (the owner's Linux server), about fifteen minutes.
- **Beside a live node:** everything it makes has a name and a label of its own (`bench/desktop/scratch.ts`): its VMs
  are `<prefix>-sbx-<id>` under `dev.<prefix>`, its images `<prefix>/sandbox:1` and `<prefix>/desktop:1`, built from
  the checkout, so the node never lists, keeps or removes one of them, and it never touches one of the node's.
  `INVINCIBLE_BENCH_SCRATCH` is the prefix (default `bench`). It joins no network and runs no prune, and removes every
  VM it made, whatever happens. A copy run from a directory with no history names its commit with
  `INVINCIBLE_BENCH_COMMIT`.

  ```sh
  INVINCIBLE_BENCH_SCRATCH=c1 INVINCIBLE_BENCH_COMMIT=$(git rev-parse --short HEAD) bun run bench desktop
  ```

- **What it measures** (C0's study, 26 November 2026, whose numbers are its first baseline):
  - boot to usable: a fresh VM, the desktop started, a page painted and read, a picture taken;
  - inside the VM: an action to its pixels changing (timed by an MIT-SHM probe), the dead time after a click, a
    screenshot;
  - the agent's path: `true`, a click, a key, a screenshot; the owner's: a look, a click, a key;
  - a look, a click and a look with the stand-in eyes;
  - typing the test string `Søren Ærø – blåbærgrød 25 °C ✓ € ü 日本語 🙂` (40 characters), exactly, and how long;
  - the four tasks (a form, a terminal command, a browser setting, a file saved in an editor), five runs each, the naive
    way and the careful way (focus checked, the screen let settle before a key that commits), each to its gate;
  - what breaks (the F tests): typing with nothing focused, a JavaScript alert, the tab in front, the picture after a
    click that navigates, double clicks, a killed browser, the last tab closed;
  - what each state costs the host (CPU and memory of the VM's QEMU, virtiofsd and shim): a VM without the desktop
    image, one whose desktop isn't started, idle, busy, watched;
  - what watching moves while the screen is still.
- **Strict:** a desktop number worse than its baseline fails the run. Speed beyond a ±20 % band (or the samples' own
  spread), not only past 2×; memory and CPU past their stated resolution; a count of passes, or a check that held,
  going down.
